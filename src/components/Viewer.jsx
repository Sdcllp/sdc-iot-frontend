import React, { useEffect, useRef, useState } from "react";
import axios from "axios";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { io } from "socket.io-client";
import "./Viewer.css";

const API_BASE_URL = (
  process.env.REACT_APP_API_BASE_URL ||
  (window.location.hostname === "localhost"
    ? "http://localhost:5000/api"
    : "https://sdc-iot-backend.onrender.com/api")
).replace(/\/$/, "");

const SOCKET_URL = API_BASE_URL.replace(/\/api$/, "");

/*
  MODEL FILE
  Put the GLB inside  frontend/public/models/  (CRA serves `public/` at the site root).
  The first path that loads is used.
*/
const PUBLIC = process.env.PUBLIC_URL || "";
const MODEL_CANDIDATES = [
  `${PUBLIC}/models/STAYBRIDGE_SUITES_2.glb`,
  `${PUBLIC}/STAYBRIDGE_SUITES_2.glb`,
  `${PUBLIC}/models/3dExport.glb`,
];

/*
  DEVICE MAPPING

  Names are matched against the mesh name AND the Revit family name of the
  object it belongs to (numeric Revit ids are ignored).

  STAYBRIDGE_SUITES_2.glb (every guest room on the ground floor has these):
    LIGHT       = Lighting_Other_LumenWerx_Shell-Recessed-8   (+ old SONO FLEX)
    AC          = Reliable_Louvers_6350DS  (!! the model has NO AC object, this
                  wall louver is used as the AC stand-in. Change "reliablelouvers"
                  below to the exact AC object name when you have one.)
    FRIDGE      = Kitchen_Refrigerator-Kenmore...
    MICROWAVE   = Microondas_-_3D...
    MOTION      = Occupancy_Sensor
    TEMPERATURE = SIDE_TABLE1   (same "side table = temperature" convention)
    LDR         = not in this model
*/
const DEVICE_MATCHERS = {
  ac: ["objectwin15", "win15", "reliablelouvers"],

  ldr: ["object30x68", "30x68", "object3068", "3068", "object3x68", "3x68"],

  light: ["sonoflex", "lumenwerx"],

  fridge: ["refrigerator", "fridge", "freezer"],

  microwave: ["microondas", "microwave"],

  motion: ["occupancysensor", "motionsensor"],

  temperature: ["sidetable2", "sidetable"],
};

// order matters: the first matching type wins
const DEVICE_TYPES = [
  "ac",
  "ldr",
  "fridge",
  "microwave",
  "temperature",
  "light",
  "motion",
];

// devices that get a live status badge inside the room
const BADGE_TYPES = [
  "light",
  "ac",
  "fridge",
  "microwave",
  "temperature",
  "motion",
  "ldr",
];

const DEVICE_TITLES = {
  light: "Light",
  ac: "AC",
  fridge: "Fridge",
  microwave: "Microwave",
  temperature: "Temperature",
  motion: "Motion",
  ldr: "LDR",
};

/*
  Things you can walk through (doors, furniture, fixtures). Everything else
  (walls, floors, stairs, windows, railings, roof, site) is solid.
*/
const NON_SOLID_RE =
  /door|sensor|lighting|lumen|marset|funiculi|cabinet|kitchen|refrigerator|dishwasher|sofa|bed|table|television|chair|basin|sanitario|toilet|sink|cook|microondas|lisabo|azucena|ssg|dumpster|rht\d|large700|casework|genericmodels|parking|esa300|thermostat|humidity|mirror|louver/;

// Walking parameters, in metres (the GLB is in metres).
const WALK = {
  eye: 1.65,
  radius: 0.35,
  stepUp: 0.55,
  stepDown: 0.7,
  wallHeights: [0.7, 1.4],
  speed: 2.8,
  run: 6,
  flySpeed: 5,
  flyVertical: 3,
  turn: 1.9, // rad/s for arrow-key turning
  look: 1.4, // rad/s for PageUp / PageDown look
  gravity: 16,
  jump: 4.6,
  mouse: 0.0024,
};

const KEY_MAP = {
  w: "forward",
  arrowup: "forward",
  s: "backward",
  arrowdown: "backward",
  a: "left",
  d: "right",
  arrowleft: "turnLeft",
  arrowright: "turnRight",
  pageup: "lookUp",
  pagedown: "lookDown",
  q: "up",
  e: "down",
  shift: "run",
  " ": "jump",
};

const MESH_NAME_RE = /^mesh[_\s-]?\d+$/i;

const cleanName = (name = "") =>
  String(name || "")
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .replace(/\./g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Object";

// The mesh itself, or its nearest named parent. Revit exports put the family
// name on the parent node and leave the mesh as "mesh_123".
const getLabelOwner = (obj) => {
  if (obj.userData.labelOwner) return obj.userData.labelOwner;

  let cur = obj;
  while (cur) {
    if (cur.name && !MESH_NAME_RE.test(cur.name)) break;
    cur = cur.parent;
  }

  obj.userData.labelOwner = cur || obj;
  return obj.userData.labelOwner;
};

const getLabel = (obj) => {
  const owner = getLabelOwner(obj);
  return MESH_NAME_RE.test(owner.name || "") ? "" : owner.name || "";
};

// "Door-Single-Panel [3026848]" -> "doorsinglepanel"
const matchName = (name = "") =>
  cleanName(String(name).replace(/[\s_-]*\[?\d{5,}\]?/g, " "))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const isMatch = (name, type) => {
  const compact = matchName(name);
  const exact = cleanName(name).toLowerCase();

  if (type === "motion") {
    // Old model: the object named exactly "Light" was the motion sensor.
    return (
      exact === "light" ||
      /\bpir\b/.test(exact) ||
      DEVICE_MATCHERS.motion.some((key) => compact.includes(key))
    );
  }

  return DEVICE_MATCHERS[type].some((key) => compact.includes(key));
};

const classifyName = (name) => {
  const compact = matchName(name);

  for (const type of DEVICE_TYPES) {
    if (type === "ldr") {
      if (
        isMatch(name, "ldr") ||
        (compact.includes("object") &&
          compact.includes("3") &&
          compact.includes("6") &&
          compact.includes("8") &&
          compact.includes("x"))
      )
        return "ldr";
    } else if (isMatch(name, type)) {
      return type;
    }
  }

  return "";
};

const percentile = (sortedValues, p) =>
  sortedValues[
    Math.min(
      sortedValues.length - 1,
      Math.max(0, Math.floor(p * (sortedValues.length - 1))),
    )
  ];

// Room number from props: 101, "101", { number: 101 } or floor + short room
const parseRoomNumber = (room, floor) => {
  const raw = room && typeof room === "object" ? room.number : room;
  if (raw === null || raw === undefined || raw === "") return null;

  const match = String(raw).match(/\d+/);
  if (!match) return null;

  const n = Number(match[0]);
  if (n >= 100) return n;
  if (floor) return Number(floor) * 100 + n;
  return null;
};

// Text + colour of the badge floating over a device
const badgeInfo = (type, data) => {
  const onOff = (value) =>
    String(value).toUpperCase() === "ON" ? "ON" : "OFF";

  switch (type) {
    case "light":
      return { value: onOff(data.light), tone: onOff(data.light) };
    case "ac":
      return {
        value: `${onOff(data.ac)} • ${data.acTemp ?? "--"}°C`,
        tone: onOff(data.ac),
      };
    case "fridge":
      return { value: onOff(data.fridge), tone: onOff(data.fridge) };
    case "microwave":
      return { value: onOff(data.microwave), tone: onOff(data.microwave) };
    case "temperature":
      return { value: `${data.temperature ?? "--"} °C`, tone: "INFO" };
    case "motion":
      return { value: `${data.motion ?? "--"}`, tone: "INFO" };
    default:
      return { value: `${data.ldr ?? "--"}`, tone: "INFO" };
  }
};

const TONE_COLORS = {
  ON: "#22c55e",
  OFF: "#ef4444",
  INFO: "#38bdf8",
};

const HAVASU_TIMEZONE = "America/Phoenix";
const HAVASU_COORDS = { latitude: 34.4839, longitude: -114.3225 };
const localHavasu = (date, options) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: HAVASU_TIMEZONE,
    ...options,
  }).format(date);
const weatherSymbol = (code) =>
  code == null
    ? "☁"
    : code === 0
      ? "☀️"
      : code <= 3
        ? "🌤️"
        : code <= 48
          ? "🌫️"
          : code <= 67
            ? "🌧️"
            : code <= 77
              ? "❄️"
              : code <= 82
                ? "🌦️"
                : "⛈️";
const weatherText = (code) =>
  code == null
    ? "Weather unavailable"
    : code === 0
      ? "Clear sky"
      : code <= 3
        ? "Partly cloudy"
        : code <= 48
          ? "Foggy"
          : code <= 67
            ? "Rain"
            : code <= 77
              ? "Snow"
              : code <= 82
                ? "Showers"
                : "Thunderstorms";

function Sparkline({ values = [], color = "#91b7ff", height = 85 }) {
  const nums = values.filter(
    (v) => typeof v === "number" && Number.isFinite(v),
  );
  if (!nums.length)
    return (
      <div
        style={{ height, opacity: 0.7, display: "grid", placeItems: "center" }}
      >
        Awaiting live weather
      </div>
    );
  const lo = Math.min(...nums),
    hi = Math.max(...nums),
    range = Math.max(hi - lo, 1);
  const points = nums
    .map(
      (v, i) =>
        `${(i / Math.max(nums.length - 1, 1)) * 300},${height - 8 - ((v - lo) / range) * (height - 20)}`,
    )
    .join(" ");
  return (
    <svg
      viewBox={`0 0 300 ${height}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height, display: "block" }}
      aria-label="Weather trend chart"
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function HotelWeatherDashboard({ visible, onNavigate }) {
  const [now, setNow] = useState(() => new Date());
  const [weather, setWeather] = useState(null);
  const [weatherError, setWeatherError] = useState("");
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${HAVASU_COORDS.latitude}&longitude=${HAVASU_COORDS.longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&hourly=temperature_2m,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&temperature_unit=celsius&wind_speed_unit=kmh&timezone=America%2FPhoenix&forecast_days=6`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Weather API: ${response.status}`);
        const data = await response.json();
        if (!cancelled) {
          setWeather(data);
          setWeatherError("");
        }
      } catch (error) {
        if (!cancelled) setWeatherError("Weather unavailable");
      }
    };
    load();
    const timer = setInterval(load, 15 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  if (!visible) return null;
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: HAVASU_TIMEZONE,
    month: "long",
    day: "numeric",
    weekday: "long",
  }).formatToParts(now);
  const datePart = (type) =>
    dateParts.find((p) => p.type === type)?.value || "";
  const hour = Number(localHavasu(now, { hour: "numeric", hourCycle: "h23" }));
  const minute = Number(localHavasu(now, { minute: "2-digit" }));
  const second = Number(localHavasu(now, { second: "2-digit" }));
  const clockFace = (deg, length, color, thickness) => (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: thickness,
        height: length,
        background: color,
        borderRadius: 4,
        transformOrigin: "50% 100%",
        transform: `translate(-50%, -100%) rotate(${deg}deg)`,
      }}
    />
  );
  const current = weather?.current;
  const days = weather?.daily;
  const hourly = weather?.hourly;
  const tempValues = hourly?.temperature_2m?.slice(0, 24) || [];
  const windValues = hourly?.wind_speed_10m?.slice(0, 24) || [];
  const panel = {
    background: "rgba(255,255,255,.83)",
    border: "1px solid rgba(255,255,255,.85)",
    borderRadius: 6,
    boxShadow: "0 2px 9px rgba(0,0,0,.16)",
    color: "#1f2937",
    backdropFilter: "blur(6px)",
  };
  const nav = [
    ["🗺️ Floor 1", "floor1"],
    ["🗺️ Floor 2", "floor2"],
    ["🗺️ Floor 3", "floor3"],
    ["🚪 Entrance", "entrance"],
    ["🪜 Stairs 1", "stairs1"],
    ["🪜 Stairs 2", "stairs2"],
  ];
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 7,
        pointerEvents: "none",
        fontFamily: "Arial, sans-serif",
        color: "#1f2937",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 58,
          left: 14,
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          maxWidth: "calc(100% - 28px)",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            ...panel,
            width: 116,
            height: 116,
            borderRadius: "50%",
            position: "relative",
            flexShrink: 0,
            border: "2px solid #ddd",
            background: "rgba(255,255,255,.90)",
          }}
        >
          {Array.from({ length: 12 }, (_, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                width: 1.5,
                height: i % 3 === 0 ? 11 : 6,
                background: "#222",
                transformOrigin: "50% 52px",
                transform: `translate(-50%,-52px) rotate(${i * 30}deg)`,
              }}
            />
          ))}
          {clockFace((hour % 12) * 30 + minute / 2, 31, "#222", 3)}
          {clockFace(minute * 6 + second / 10, 43, "#222", 2)}
          {clockFace(second * 6, 46, "#f97316", 2)}
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "#222",
              transform: "translate(-50%,-50%)",
            }}
          />
        </div>
        <div
          style={{
            ...panel,
            width: 126,
            height: 124,
            textAlign: "center",
            flexShrink: 0,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              background: "#303030",
              color: "white",
              padding: 6,
              fontSize: 13,
            }}
          >
            {datePart("month")}
          </div>
          <div style={{ fontSize: 42, fontWeight: 700, lineHeight: "49px" }}>
            {datePart("day")}
          </div>
          <div style={{ fontSize: 14 }}>{datePart("weekday")}</div>
          <div style={{ fontSize: 11, marginTop: 5, color: "#64748b" }}>
            {localHavasu(now, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: true,
            })}{" "}
            MST
          </div>
        </div>
        <div
          style={{
            ...panel,
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 16px",
            minWidth: 285,
            height: 80,
          }}
        >
          <div style={{ fontSize: 51, lineHeight: 1 }}>
            {weatherSymbol(current?.weather_code)}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>
              Lake Havasu City, AZ
            </div>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              {weatherText(current?.weather_code)}
            </div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
              Humidity {current?.relative_humidity_2m ?? "--"}% · Wind{" "}
              {current?.wind_speed_10m ?? "--"} km/h
            </div>
          </div>
          <div style={{ fontSize: 30, fontWeight: 700, whiteSpace: "nowrap" }}>
            {current?.temperature_2m == null
              ? "--"
              : `${current.temperature_2m.toFixed(1)}°C`}
          </div>
        </div>
        <div
          style={{
            ...panel,
            display: "grid",
            gridTemplateColumns: "repeat(5, 52px)",
            gap: 6,
            padding: "8px 10px",
            height: 87,
            boxSizing: "border-box",
          }}
        >
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} style={{ textAlign: "center", fontSize: 10 }}>
              <div style={{ fontSize: 22 }}>
                {weatherSymbol(days?.weather_code?.[i + 1])}
              </div>
              <div>
                {days?.time?.[i + 1]
                  ? new Date(`${days.time[i + 1]}T12:00:00`).toLocaleDateString(
                      "en-US",
                      { weekday: "short", timeZone: HAVASU_TIMEZONE },
                    )
                  : "--"}
              </div>
              <div style={{ marginTop: 4, whiteSpace: "nowrap" }}>
                {days?.temperature_2m_max?.[i + 1] == null
                  ? "--"
                  : Math.round(days.temperature_2m_max[i + 1])}
                ° |{" "}
                {days?.temperature_2m_min?.[i + 1] == null
                  ? "--"
                  : Math.round(days.temperature_2m_min[i + 1])}
                °
              </div>
            </div>
          ))}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          top: 188,
          left: 14,
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          maxWidth: "calc(100% - 28px)",
        }}
      >
        {[
          ["🏨 Free rooms", "2", "#15803d"],
          ["🛏️ Occupied", "4", "#dc2626"],
          ["⛔ Do not disturb", "2", "#dc2626"],
          ["🧹 Cleaning", "0", "#2563eb"],
          ["🛡️ Out of order", "1", "#dc2626"],
        ].map(([label, value, color]) => (
          <div
            key={label}
            style={{
              ...panel,
              padding: "7px 10px",
              fontSize: 12,
              color,
              fontWeight: 700,
            }}
          >
            {label}: {value}
          </div>
        ))}
        <span
          style={{
            fontSize: 10,
            color: "#475569",
            alignSelf: "center",
            background: "rgba(255,255,255,.8)",
            padding: 3,
            borderRadius: 4,
          }}
        >
          Demo occupancy
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 14,
          left: 14,
          width: 340,
          maxWidth: "calc(100vw - 28px)",
          display: "grid",
          gridTemplateColumns: "repeat(2,minmax(0,1fr))",
          pointerEvents: "auto",
        }}
      >
        {nav.map(([label, target]) => (
          <button
            key={target}
            type="button"
            onClick={() => onNavigate(target)}
            style={{
              ...panel,
              borderRadius: 0,
              textAlign: "left",
              padding: "15px 13px",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {label}
            <span style={{ float: "right" }}>›</span>
          </button>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 14,
          right: 14,
          width: 450,
          maxWidth: "calc(100vw - 28px)",
          ...panel,
          padding: 12,
          boxSizing: "border-box",
        }}
      >
        <div style={{ fontSize: 12, marginBottom: 4 }}>
          🌡️ Temperature (next 24 hours)
        </div>
        <Sparkline values={tempValues} color="#8b9de8" height={75} />
        <div style={{ fontSize: 12, margin: "10px 0 4px" }}>
          💨 Wind (next 24 hours)
        </div>
        <Sparkline values={windValues} color="#5aa9d3" height={75} />
        <div style={{ fontSize: 10, color: "#64748b", marginTop: 5 }}>
          {weatherError || "Weather: Open-Meteo · Live"}
        </div>
      </div>
    </div>
  );
}

export default function Viewer({ floor, room }) {
  const mountRef = useRef(null);
  const [hotelDashboardVisible, setHotelDashboardVisible] = useState(true);
  useEffect(() => {
    const handler = (event) => {
      const view = event.detail?.view || "hotel";
      setHotelDashboardVisible(view === "hotel");
      if (view === "hotel") setViewerMode("hotel");
      else if (/^floor/i.test(view)) setViewerMode("floor");
      else if (view === "room") setViewerMode("room");
    };
    window.addEventListener("staybridge:view", handler);
    return () => window.removeEventListener("staybridge:view", handler);
  }, []);

  const [selectedName, setSelectedName] = useState("None");
  const [selectedControl, setSelectedControl] = useState("");
  const [loadedFile, setLoadedFile] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loadProgress, setLoadProgress] = useState(0);
  const [modelReady, setModelReady] = useState(false);
  const [currentRoomLabel, setCurrentRoomLabel] = useState("");
  const [viewerMode, setViewerMode] = useState("hotel");
  const [activeFloorNo, setActiveFloorNo] = useState(1);
  const [selectedStatusRoom, setSelectedStatusRoom] = useState(null);
  const [roomStatuses, setRoomStatuses] = useState({});
  const [roomServiceStates, setRoomServiceStates] = useState({});
  // DOM room cards are created inside the Three.js effect. Refs keep them in sync
  // with React without rebuilding the entire 3D scene on each status change.
  const roomStatusesRef = useRef({});
  const roomServiceRef = useRef({});
  const roomCardRevision = useRef(0);
  useEffect(() => {
    roomStatusesRef.current = roomStatuses;
    roomCardRevision.current += 1;
  }, [roomStatuses]);
  useEffect(() => {
    roomServiceRef.current = roomServiceStates;
    roomCardRevision.current += 1;
  }, [roomServiceStates]);
  const statusOptions = [
    ["Vacant", "⌂", "#15803d"],
    ["Occupied", "⌂", "#ef4444"],
    ["Do Not Disturb", "⊘", "#ef4444"],
    ["Room Service Request", "♨", "#d4a017"],
    ["Cleaning in progress", "⚒", "#2563eb"],
    ["Ready", "✓", "#16a34a"],
    ["Not Ready", "⊗", "#ea580c"],
    ["Out of Order", "◇", "#dc2626"],
  ];
  const updateRoomStatus = (status) => {
    if (!selectedStatusRoom) return;
    setRoomStatuses((prev) => ({ ...prev, [selectedStatusRoom]: status }));
    window.dispatchEvent(
      new CustomEvent("viewer:room-status-change", {
        detail: { room: selectedStatusRoom, status },
      }),
    );
  };
  // Local demonstration states; these do not claim to control physical devices.
  const [roomControls, setRoomControls] = useState({
    light: false,
    ac: false,
    tv: false,
    fridge: false,
    microwave: false,
    curtains: true,
    power: true,
  });
  const [roomTemp, setRoomTemp] = useState(24);
  const changeRoomControl = (key) => {
    setRoomControls((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      demoDeviceRef.current = next;
      window.dispatchEvent(
        new CustomEvent("viewer:demo-devices", { detail: next }),
      );
      return next;
    });
  };
  const [sending, setSending] = useState(false);
  const [controlMessage, setControlMessage] = useState("");

  const [deviceData, setDeviceData] = useState({
    temperature: "--",
    motion: "--",
    ldr: "--",
    light: "OFF",
    ac: "OFF",
    acTemp: 24,
    fridge: "OFF",
    microwave: "OFF",
    updatedAt: null,
  });

  const apiRef = useRef(null);
  const latestDeviceDataRef = useRef(deviceData);
  const demoDeviceRef = useRef(roomControls);

  useEffect(() => {
    latestDeviceDataRef.current = deviceData;
  }, [deviceData]);

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
      reconnection: true,
    });

    socket.on("deviceData", (data) => {
      setDeviceData((prev) => ({ ...prev, ...data }));
    });

    return () => socket.disconnect();
  }, []);

  const getErrorMessage = (error, fallback) => {
    console.error(fallback, error.response?.data || error.message);
    return (
      error.response?.data?.message ||
      error.response?.data?.error ||
      error.message ||
      fallback
    );
  };

  // One helper for every POST /devices/... call
  const sendControl = async (endpoint, payload, okText, failText) => {
    try {
      setSending(true);
      setControlMessage("");

      const res = await axios.post(
        `${API_BASE_URL}/devices/${endpoint}`,
        payload,
      );

      if (res.data?.success) {
        setDeviceData((prev) => ({ ...prev, ...res.data.data }));
        setControlMessage(res.data.message || okText);
      } else {
        setControlMessage(res.data?.message || failText);
      }
    } catch (error) {
      setControlMessage(getErrorMessage(error, failText));
    } finally {
      setSending(false);
    }
  };

  const controlLight = (state) =>
    sendControl(
      "light",
      { state },
      `Light ${state}`,
      "Failed to control light",
    );

  const controlAC = (state) =>
    sendControl("ac", { state }, `AC ${state}`, "Failed to control AC");

  const controlACTemp = (temp) =>
    sendControl(
      "ac-temp",
      { temp },
      `AC temp set to ${temp}°C`,
      "Failed to set AC temperature",
    );

  const controlFridge = (state) =>
    sendControl(
      "fridge",
      { state },
      `Fridge ${state}`,
      "Failed to control fridge",
    );

  const controlMicrowave = (state) =>
    sendControl(
      "microwave",
      { state },
      `Microwave ${state}`,
      "Failed to control microwave",
    );

  const toggleDevice = (type) => {
    const data = latestDeviceDataRef.current;
    const next = (key) =>
      String(data[key]).toUpperCase() === "ON" ? "OFF" : "ON";

    if (type === "light") controlLight(next("light"));
    else if (type === "ac") controlAC(next("ac"));
    else if (type === "fridge") controlFridge(next("fridge"));
    else if (type === "microwave") controlMicrowave(next("microwave"));
  };

  const goToDevice = (type) => {
    setSelectedControl(type);
    apiRef.current?.goToType(type);
  };

  // Sidebar -> room (props)
  useEffect(() => {
    if (!modelReady || !floor) return;
    apiRef.current?.showFloor(Number(floor));
  }, [floor, modelReady]);

  useEffect(() => {
    if (!modelReady) return;
    const number = parseRoomNumber(room, floor);
    if (number) apiRef.current?.goToRoom(number);
  }, [room, floor, modelReady]);

  // Sidebar -> room (event, works even if App.js does not pass props)
  useEffect(() => {
    const handler = (event) => {
      const number = parseRoomNumber(event.detail?.room, event.detail?.floor);
      if (number) apiRef.current?.goToRoom(number);
    };

    const floorHandler = (event) => {
      const n = Number(event.detail?.floor);
      if (n) apiRef.current?.showFloor(n);
    };

    window.addEventListener("viewer:enter-room", handler);
    window.addEventListener("viewer:show-floor", floorHandler);
    return () => {
      window.removeEventListener("viewer:enter-room", handler);
      window.removeEventListener("viewer:show-floor", floorHandler);
    };
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    if (window.getComputedStyle(mount).position === "static") {
      mount.style.position = "relative";
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf5f5f5);

    const camera = new THREE.PerspectiveCamera(
      60,
      mount.clientWidth / mount.clientHeight,
      0.1,
      3000,
    );
    camera.position.set(0, 18, 45);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.domElement.style.touchAction = "none";
    renderer.domElement.style.outline = "none";
    renderer.domElement.setAttribute("tabindex", "0");
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.enableRotate = true;
    controls.rotateSpeed = 0.8;
    controls.zoomSpeed = 1.2;
    controls.panSpeed = 0.8;
    controls.minDistance = 0.001;
    controls.maxDistance = 500;
    controls.target.set(0, 0, 0);

    const ambient = new THREE.AmbientLight(0xffffff, 1.0);
    scene.add(ambient);

    const light1 = new THREE.DirectionalLight(0xffffff, 1.5);
    light1.position.set(20, 40, 20);
    scene.add(light1);

    const light2 = new THREE.DirectionalLight(0xffffff, 0.6);
    light2.position.set(-20, 20, -20);
    scene.add(light2);
    // Give the 3D room an observable lighting change when its demo switch is used.
    const handleDemoLighting = (event) => {
      const states = event.detail || {};
      demoDeviceRef.current = states;
      const on = states.power !== false && states.light !== false;
      ambient.intensity = on ? 1.0 : 0.12;
      light1.intensity = on ? 1.5 : 0.15;
      light2.intensity = on ? 0.6 : 0.05;
    };
    window.addEventListener("viewer:demo-devices", handleDemoLighting);

    const modelGroup = new THREE.Group();
    scene.add(modelGroup);

    const pivot = new THREE.Group();
    modelGroup.add(pivot);

    const loader = new GLTFLoader();
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    let animationId = null;
    let disposed = false;

    /* ------------------------------------------------------------------
       STATE
    ------------------------------------------------------------------ */
    const walk = {
      active: false,
      fly: false,
      yaw: 0,
      pitch: 0,
      feetY: 0,
      vy: 0,
      grounded: false,
    };

    const keys = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      turnLeft: false,
      turnRight: false,
      lookUp: false,
      lookDown: false,
      up: false,
      down: false,
      run: false,
      jump: false,
    };

    const fpsClock = new THREE.Clock();
    let pointerLocked = false;
    let dragLook = null;
    let dragMoved = false;

    let framingBox = null; // building box (outliers removed)
    let walkBounds = null;
    let solids = []; // [{ mesh, box }]
    let devices = []; // [{ id, type, owner, meshes, box, center, room }]
    let rooms = []; // [{ index, center, floorY, topY, spawn, rep }]
    let levels = null; // floor heights, ground floor first
    let selectedDevice = null;
    let selectedRoomIndex = 0;
    let currentRoom = { index: -1, floorIdx: 0 };
    let lastRoomCheck = 0;
    let lastOcclusionCheck = 0;
    let areas = []; // [{ id, label, center, box, floorY, dist }]
    let planMode = null; // { type: "floor", floorNo } | { type: "room", number }
    let planItems = []; // HTML cards / tiles projected over the plan view
    const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);

    const nearCache = { x: Infinity, y: Infinity, z: Infinity, list: [] };

    const tmpV = new THREE.Vector3();
    const tmpV2 = new THREE.Vector3();
    const tmpDir = new THREE.Vector3();
    const tmpNormal = new THREE.Vector3();
    const rayOrigin = new THREE.Vector3();
    const rayDown = new THREE.Vector3(0, -1, 0);
    const rayUp = new THREE.Vector3(0, 1, 0);
    const walkRay = new THREE.Raycaster();

    /* ------------------------------------------------------------------
       HUD + ON-SCREEN BUTTONS + STATUS BADGES
    ------------------------------------------------------------------ */
    const hud = document.createElement("div");
    Object.assign(hud.style, {
      position: "absolute",
      top: "60px",
      left: "50%",
      transform: "translateX(-50%)",
      padding: "6px 12px",
      borderRadius: "999px",
      background: "rgba(15,23,42,0.78)",
      color: "#fff",
      font: "12px/1.4 system-ui, sans-serif",
      pointerEvents: "none",
      display: "none",
      zIndex: 5,
      whiteSpace: "nowrap",
      maxWidth: "94%",
      overflow: "hidden",
      textOverflow: "ellipsis",
    });
    mount.appendChild(hud);

    const updateHud = () => {
      hud.textContent =
        `${walk.fly ? "FLY" : "WALK"} mode  •  W/A/S/D or ↑↓ move  •  ←→ turn  •  ` +
        `drag mouse to look  •  Shift run  •  Space ${walk.fly ? "up" : "jump"}  •  ` +
        `Q/E fly up/down  •  F ${walk.fly ? "walk" : "fly"}`;
    };

    const badgeLayer = document.createElement("div");
    Object.assign(badgeLayer.style, {
      position: "absolute",
      inset: "0",
      overflow: "hidden",
      pointerEvents: "none",
      zIndex: 4,
    });
    mount.appendChild(badgeLayer);

    const padRoot = document.createElement("div");
    Object.assign(padRoot.style, {
      position: "absolute",
      left: "0",
      right: "0",
      bottom: "14px",
      display: "none",
      justifyContent: "space-between",
      alignItems: "flex-end",
      padding: "0 14px",
      pointerEvents: "none",
      zIndex: 5,
    });
    mount.appendChild(padRoot);

    let flyButton = null;

    const makePadButton = (parent, label, title, onDown, onUp) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.title = title;
      button.setAttribute("aria-label", title);
      button.tabIndex = -1;
      Object.assign(button.style, {
        width: "46px",
        height: "46px",
        borderRadius: "12px",
        border: "1px solid rgba(255,255,255,0.35)",
        background: "rgba(15,23,42,0.72)",
        color: "#fff",
        font: "600 17px/1 system-ui, sans-serif",
        cursor: "pointer",
        pointerEvents: "auto",
        touchAction: "none",
        userSelect: "none",
        padding: "0",
      });

      const press = (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          button.setPointerCapture(event.pointerId);
        } catch (error) {
          /* ignore */
        }
        button.style.background = "rgba(37,99,235,0.9)";
        onDown();
      };
      const release = (event) => {
        event.stopPropagation();
        button.style.background = "rgba(15,23,42,0.72)";
        onUp();
      };

      button.addEventListener("pointerdown", press);
      button.addEventListener("pointerup", release);
      button.addEventListener("pointercancel", release);
      button.addEventListener("lostpointercapture", release);
      button.addEventListener("contextmenu", (e) => e.preventDefault());

      parent.appendChild(button);
      return button;
    };

    const holdKey = (name) => [
      () => {
        keys[name] = true;
        if (name === "up" || name === "down") setFly(true);
      },
      () => {
        keys[name] = false;
      },
    ];

    const makeCluster = (cells) => {
      const grid = document.createElement("div");
      Object.assign(grid.style, {
        display: "grid",
        gridTemplateColumns: "repeat(3, 46px)",
        gridAutoRows: "46px",
        gap: "6px",
        pointerEvents: "none",
      });
      cells.forEach((cell) => {
        if (!cell) {
          grid.appendChild(document.createElement("span"));
          return;
        }
        const [label, title, key] = cell;
        makePadButton(grid, label, title, ...holdKey(key));
      });
      padRoot.appendChild(grid);
    };

    // Left pad: move
    makeCluster([
      null,
      ["▲", "Forward (↑ / W)", "forward"],
      null,
      ["◀", "Strafe left (A)", "left"],
      ["▼", "Backward (↓ / S)", "backward"],
      ["▶", "Strafe right (D)", "right"],
    ]);

    // Right pad: turn / look / height
    makeCluster([
      ["⤒", "Look up (Page Up)", "lookUp"],
      ["⬆", "Fly up (Q / Space)", "up"],
      ["⤓", "Look down (Page Down)", "lookDown"],
      ["⟲", "Turn left (←)", "turnLeft"],
      ["⬇", "Fly down (E)", "down"],
      ["⟳", "Turn right (→)", "turnRight"],
    ]);

    flyButton = document.createElement("button");
    flyButton.type = "button";
    flyButton.tabIndex = -1;
    Object.assign(flyButton.style, {
      position: "absolute",
      right: "14px",
      bottom: "132px",
      padding: "8px 12px",
      borderRadius: "10px",
      border: "1px solid rgba(255,255,255,0.35)",
      background: "rgba(15,23,42,0.78)",
      color: "#fff",
      font: "600 12px system-ui, sans-serif",
      cursor: "pointer",
      display: "none",
      zIndex: 5,
    });
    flyButton.addEventListener("click", (event) => {
      event.stopPropagation();
      setFly(!walk.fly);
      renderer.domElement.focus();
    });
    mount.appendChild(flyButton);

    const setPadVisible = (visible) => {
      padRoot.style.display = visible ? "flex" : "none";
      hud.style.display = visible ? "block" : "none";
      flyButton.style.display = visible ? "block" : "none";
      if (!visible) badgeLayer.style.display = "none";
    };

    function setFly(value) {
      walk.fly = value;
      walk.vy = 0;
      walk.grounded = false;
      if (flyButton) flyButton.textContent = value ? "Walk (F)" : "Fly (F)";
      updateHud();
    }

    const resetKeys = () => {
      Object.keys(keys).forEach((key) => {
        keys[key] = false;
      });
    };

    /* ------------------------------------------------------------------
       COLLISION HELPERS
       Rays must hit walls from both sides whatever `material.side` the
       GLB uses, so `side` is switched to DoubleSide only for the duration
       of a ray test and restored right away (nothing is rendered in between).
    ------------------------------------------------------------------ */
    const NEAR_RADIUS = 7;
    const NEAR_REFRESH = 2;

    const getNearSolids = (x, y, z) => {
      const dx = x - nearCache.x;
      const dy = y - nearCache.y;
      const dz = z - nearCache.z;

      if (dx * dx + dy * dy + dz * dz > NEAR_REFRESH * NEAR_REFRESH) {
        tmpV.set(x, y, z);
        nearCache.list = solids
          .filter((item) => item.box.distanceToPoint(tmpV) < NEAR_RADIUS)
          .map((item) => item.mesh);
        nearCache.x = x;
        nearCache.y = y;
        nearCache.z = z;
      }

      return nearCache.list;
    };

    const castSolids = (origin, dir, far, list) => {
      const changed = [];

      list.forEach((mesh) => {
        const mats = Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material];
        mats.forEach((mat) => {
          if (mat && mat.side !== THREE.DoubleSide) {
            changed.push(mat, mat.side);
            mat.side = THREE.DoubleSide;
          }
        });
      });

      walkRay.set(origin, dir);
      walkRay.near = 0;
      walkRay.far = far;
      const hits = walkRay.intersectObjects(list, false);

      for (let i = 0; i < changed.length; i += 2) {
        changed[i].side = changed[i + 1];
      }

      return hits;
    };

    const worldNormal = (hit) => {
      if (!hit.face) return tmpNormal.set(0, 1, 0);
      return tmpNormal
        .copy(hit.face.normal)
        .transformDirection(hit.object.matrixWorld);
    };

    // Highest upward-facing surface between `fromY` and `fromY - far`.
    const sampleFloor = (x, z, fromY, far) => {
      const list = getNearSolids(x, fromY - far * 0.5, z);
      rayOrigin.set(x, fromY, z);

      const hits = castSolids(rayOrigin, rayDown, far, list);
      for (const hit of hits) {
        if (worldNormal(hit).y > 0.35) return hit.point.y;
      }
      return null;
    };

    // Distance to whatever is above (ceiling / roof), or null.
    const ceilingDistance = (x, y, z, maxDist) => {
      const list = getNearSolids(x, y, z);
      rayOrigin.set(x, y, z);
      const hits = castSolids(rayOrigin, rayUp, maxDist, list);
      return hits.length ? hits[0].distance : null;
    };

    // Distance to the nearest wall in a horizontal direction.
    const wallDistance = (x, y, z, dirX, dirZ, maxDist) => {
      const list = getNearSolids(x, y, z);
      rayOrigin.set(x, y, z);
      tmpDir.set(dirX, 0, dirZ).normalize();

      const hits = castSolids(rayOrigin, tmpDir, maxDist, list);
      for (const hit of hits) {
        const n = worldNormal(hit);
        if (Math.abs(n.y) < 0.7) {
          return { distance: hit.distance, nx: n.x, nz: n.z };
        }
      }
      return null;
    };

    // Is a solid between two points? (ignores the last `margin` metres)
    const segmentBlocked = (from, to, margin) => {
      tmpV2.subVectors(to, from);
      const length = tmpV2.length();
      if (length < 0.01) return false;
      tmpV2.divideScalar(length);

      const list = getNearSolids(from.x, from.y, from.z);
      const hits = castSolids(from, tmpV2, length, list);
      return hits.some((hit) => hit.distance < length - margin);
    };

    // Move on the XZ plane without entering walls; slides along them.
    const resolveMove = (px, pz, feetY, mx, mz) => {
      let x = px;
      let z = pz;
      let curX = mx;
      let curZ = mz;

      for (let i = 0; i < 3; i++) {
        const len = Math.hypot(curX, curZ);
        if (len < 1e-6) break;

        const dirX = curX / len;
        const dirZ = curZ / len;
        let best = null;

        for (const h of WALK.wallHeights) {
          const hit = wallDistance(
            x,
            feetY + h,
            z,
            dirX,
            dirZ,
            len + WALK.radius,
          );
          if (hit && (!best || hit.distance < best.distance)) best = hit;
        }

        if (!best) {
          x += curX;
          z += curZ;
          break;
        }

        let nx = best.nx;
        let nz = best.nz;
        if (nx * dirX + nz * dirZ > 0) {
          nx = -nx;
          nz = -nz;
        }

        const allowed = Math.max(0, best.distance - WALK.radius - 0.001);
        x += dirX * allowed;
        z += dirZ * allowed;

        const remain = Math.max(0, len - allowed);
        const rx = dirX * remain;
        const rz = dirZ * remain;
        const dot = rx * nx + rz * nz;
        curX = rx - nx * dot;
        curZ = rz - nz * dot;
      }

      return [x - px, z - pz];
    };

    /* ------------------------------------------------------------------
       CAMERA MODES
    ------------------------------------------------------------------ */
    const applyWalkRotation = () => {
      camera.rotation.order = "YXZ";
      camera.rotation.set(walk.pitch, walk.yaw, 0);
    };

    const exitPointerLock = () => {
      if (document.pointerLockElement === renderer.domElement) {
        document.exitPointerLock();
      }
    };

    const clearPlan = () => {
      if (!planMode && renderer.clippingPlanes.length === 0) return;
      planMode = null;
      planItems = [];
      renderer.clippingPlanes = [];
      controls.enableRotate = true;
      controls.minDistance = 0.05;
      cardsLayer.style.display = "none";
      cardsLayer.textContent = "";
      planBar.style.display = "none";
      setActiveNav("");
    };

    // Look straight down at `center`, everything above `cutY` is cut away
    // (that removes the roof / ceilings, like a real floor plan).
    const topDown = (center, spanZ, spanX, cutY) => {
      walk.active = false;
      resetKeys();
      setPadVisible(false);
      exitPointerLock();

      clipPlane.constant = cutY;
      renderer.clippingPlanes = [clipPlane];

      controls.enabled = true;
      controls.enablePan = true;
      controls.enableZoom = true;
      controls.enableRotate = false;

      camera.fov = 40;
      camera.near = 0.5;
      camera.far = 800;
      camera.updateProjectionMatrix();

      const aspect = Math.max(
        mount.clientWidth / Math.max(mount.clientHeight, 1),
        0.1,
      );
      const vf = THREE.MathUtils.degToRad(camera.fov);
      const hf = 2 * Math.atan(Math.tan(vf / 2) * aspect);
      const height =
        Math.max(spanZ / 2 / Math.tan(hf / 2), spanX / 2 / Math.tan(vf / 2)) *
        1.05;

      const lookY = cutY - 1.2;
      controls.minDistance = 3;
      controls.maxDistance = 400;
      controls.target.set(center.x, lookY, center.z);
      // tiny offset: screen-right = +z (room numbers grow to the right)
      camera.position.set(center.x - height * 0.002, lookY + height, center.z);
      camera.lookAt(controls.target);
      controls.update();
      selectedDevice = null;
    };

    const fitCameraToObject = () => {
      clearPlan();
      walk.active = false;
      resetKeys();
      setPadVisible(false);
      exitPointerLock();

      controls.enabled = true;
      controls.enablePan = true;
      controls.enableZoom = true;
      controls.enableRotate = true;

      const box = framingBox || new THREE.Box3().setFromObject(modelGroup);
      if (box.isEmpty()) return;

      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(size.length() / 2, 0.1);

      camera.fov = 45;
      camera.near = Math.max(radius / 2000, 0.05);
      camera.far = Math.max(radius * 100, 1000);
      camera.updateProjectionMatrix();

      const aspect = Math.max(
        mount.clientWidth / Math.max(mount.clientHeight, 1),
        0.1,
      );
      const verticalFov = THREE.MathUtils.degToRad(camera.fov);
      const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);

      // look at the long side of the building
      const alongX = size.z >= size.x;
      const along = alongX ? size.z : size.x;
      const depth = alongX ? size.x : size.z;

      const distance =
        Math.max(
          size.y / 2 / Math.tan(verticalFov / 2),
          along / 2 / Math.tan(horizontalFov / 2),
        ) *
          1.15 +
        depth / 2;

      controls.target.copy(center);
      camera.position.set(
        center.x + (alongX ? distance : 0),
        center.y + Math.max(size.y * 0.3, radius * 0.12),
        center.z + (alongX ? 0 : distance),
      );

      controls.minDistance = Math.max(radius * 0.005, 0.05);
      controls.maxDistance = radius * 40;
      camera.lookAt(center);
      controls.update();

      selectedDevice = null;
    };

    // Put the player at `pos` (eye position) looking along yaw / pitch.
    const startWalk = (pos, yaw, pitch = 0) => {
      // Entering a 3D interior must never leave the floor-status popup visible.
      setViewerMode("room");
      setSelectedStatusRoom(null);
      setHotelDashboardVisible(false);
      clearPlan();
      resetKeys();
      exitPointerLock();

      walk.active = true;
      walk.yaw = yaw;
      walk.pitch = THREE.MathUtils.clamp(pitch, -1.45, 1.45);
      walk.vy = 0;
      walk.grounded = false;
      walk.fly = false;
      walk.feetY = pos.y - WALK.eye;

      camera.position.copy(pos);
      camera.fov = 75;
      camera.near = 0.05;
      camera.far = 2500;
      camera.updateProjectionMatrix();
      applyWalkRotation();

      controls.enabled = false;
      controls.target.set(pos.x - Math.sin(yaw), pos.y, pos.z - Math.cos(yaw));

      setFly(false);
      setPadVisible(true);
      badgeLayer.style.display = "block";
      lastRoomCheck = 0;

      renderer.domElement.focus();
    };

    const lookAtYawPitch = (from, to) => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dz = to.z - from.z;
      return {
        yaw: Math.atan2(-dx, -dz),
        pitch: Math.atan2(dy, Math.hypot(dx, dz)),
      };
    };

    /* ------------------------------------------------------------------
       MODEL PREPARATION
    ------------------------------------------------------------------ */
    // Revit exports often contain a few stray objects far away from the
    // building. Hide them and compute the real bounds of the building.
    const prepareModel = (root) => {
      root.updateMatrixWorld(true);

      const items = [];
      root.traverse((child) => {
        if (!child.isMesh) return;
        const box = new THREE.Box3().setFromObject(child);
        if (box.isEmpty()) return;
        items.push({ mesh: child, box });
      });

      const med = (axis) =>
        percentile(
          items.map((i) => i.box.getCenter(tmpV)[axis]).sort((a, b) => a - b),
          0.5,
        );
      const median = new THREE.Vector3(med("x"), med("y"), med("z"));

      const keep = [];
      items.forEach((item) => {
        if (item.box.getCenter(tmpV).distanceTo(median) > 400) {
          item.mesh.visible = false;
        } else {
          keep.push(item);
        }
      });

      const centers = keep.map((i) => i.box.getCenter(new THREE.Vector3()));
      const xs = centers.map((c) => c.x).sort((a, b) => a - b);
      const zs = centers.map((c) => c.z).sort((a, b) => a - b);
      const minYs = keep.map((i) => i.box.min.y).sort((a, b) => a - b);
      const maxYs = keep.map((i) => i.box.max.y).sort((a, b) => a - b);

      const pad = 4;
      const framing = new THREE.Box3(
        new THREE.Vector3(
          percentile(xs, 0.02) - pad,
          percentile(minYs, 0.005),
          percentile(zs, 0.02) - pad,
        ),
        new THREE.Vector3(
          percentile(xs, 0.98) + pad,
          percentile(maxYs, 0.995),
          percentile(zs, 0.98) + pad,
        ),
      );

      const bounds = new THREE.Box3(
        new THREE.Vector3(
          percentile(xs, 0.002) - 40,
          percentile(minYs, 0.002) - 6,
          percentile(zs, 0.002) - 40,
        ),
        new THREE.Vector3(
          percentile(xs, 0.998) + 40,
          percentile(maxYs, 0.998) + 40,
          percentile(zs, 0.998) + 40,
        ),
      );

      // Move the building to the origin (no scaling, 1 unit = 1 metre).
      const c = framing.getCenter(new THREE.Vector3());
      const shift = new THREE.Vector3(-c.x, -framing.min.y, -c.z);
      pivot.position.copy(shift);
      pivot.updateMatrixWorld(true);

      framing.translate(shift);
      bounds.translate(shift);
      keep.forEach((item) => item.box.translate(shift));

      framingBox = framing;
      walkBounds = bounds;

      return keep;
    };

    // Devices, solid geometry and rooms
    const buildRegistry = (items) => {
      solids = [];
      devices = [];
      nearCache.x = Infinity;

      const byOwner = new Map();
      const bedBoxes = [];

      items.forEach(({ mesh, box }) => {
        const label = getLabel(mesh);
        const source = label || mesh.name;
        const compact = matchName(source);

        if (/^(king|queen|double|twin|single)?bed\d*$/.test(compact)) {
          bedBoxes.push(box);
        }

        const type = classifyName(source);

        if (type) {
          const owner = getLabelOwner(mesh);
          let device = byOwner.get(owner.uuid);

          if (!device) {
            device = {
              id: devices.length,
              type,
              owner,
              meshes: [],
              box: new THREE.Box3(),
              center: new THREE.Vector3(),
              room: -1,
            };
            devices.push(device);
            byOwner.set(owner.uuid, device);
          }

          device.meshes.push(mesh);
          device.box.union(box);

          mesh.userData.deviceId = device.id;
          mesh.userData.deviceType = type;
          mesh.userData.isDevice = true;
          return;
        }

        const size = box.getSize(tmpV);
        if (Math.max(size.x, size.y, size.z) < 0.1) return;
        if (NON_SOLID_RE.test(compact)) return;

        mesh.userData.isSolid = true;
        solids.push({ mesh, box });
      });

      devices.forEach((device) => {
        device.box.getCenter(device.center);
      });

      // One room per bed, ordered along the building (101, 102, ...)
      rooms = bedBoxes
        .map((box) => ({
          center: box.getCenter(new THREE.Vector3()),
          floorY: box.min.y,
          topY: box.max.y,
          spawn: undefined,
          rep: {},
        }))
        .sort(
          (a, b) =>
            Math.round(a.center.z * 2) / 2 - Math.round(b.center.z * 2) / 2 ||
            a.center.x - b.center.x,
        );
      rooms.forEach((r, index) => {
        r.index = index;
      });

      // device -> room (nearest bed on the same floor)
      devices.forEach((device) => {
        let best = null;
        rooms.forEach((r) => {
          if (Math.abs(device.center.y - r.floorY) > 5) return;
          const d = Math.hypot(
            device.center.x - r.center.x,
            device.center.z - r.center.z,
          );
          if (d < 9.5 && (!best || d < best.d)) best = { d, index: r.index };
        });

        if (!best) return;
        device.room = best.index;

        const r = rooms[best.index];
        const current = r.rep[device.type];
        if (!current || best.d < current.d) {
          r.rep[device.type] = { device, d: best.d };
        }
      });

      // Places that are not rooms: main entrance and stairs
      areas = [];
      const baseY = rooms[0] ? rooms[0].floorY : 0;
      const entranceBox = new THREE.Box3();
      const stairs = [];

      items.forEach(({ mesh, box }) => {
        const label = getLabel(mesh) || mesh.name;
        if (box.min.y > baseY + 1.5) return;

        if (/push.?bar/i.test(label)) entranceBox.union(box);

        if (/assembled.?stair|monolithic.?run/i.test(label)) {
          const c = box.getCenter(new THREE.Vector3());
          let group = stairs.find(
            (g) => Math.hypot(g.c.x - c.x, g.c.z - c.z) < 9,
          );
          if (!group) {
            group = { c, box: new THREE.Box3() };
            stairs.push(group);
          }
          group.box.union(box);
        }
      });

      if (!entranceBox.isEmpty()) {
        const c = entranceBox.getCenter(new THREE.Vector3());
        c.y = baseY + 1.2;
        areas.push({
          id: "entrance",
          label: "Entrance",
          center: c,
          box: entranceBox,
          floorY: baseY,
          dist: 3.5,
        });
      }

      stairs
        .sort((a, b) => a.c.z - b.c.z)
        .forEach((g, i) => {
          const c = g.box.getCenter(new THREE.Vector3());
          c.y = baseY + 1.2;
          areas.push({
            id: `stairs${i + 1}`,
            label: stairs.length > 1 ? `Stairs ${i + 1}` : "Stairs",
            center: c,
            box: g.box,
            floorY: baseY,
            dist: 3.5,
          });
        });

      const counts = {};
      devices.forEach((d) => {
        counts[d.type] = (counts[d.type] || 0) + 1;
      });
      console.log("IoT devices found in GLB:", counts);
      console.table(
        rooms.map((r) => ({
          room: 101 + r.index,
          x: +r.center.x.toFixed(1),
          z: +r.center.z.toFixed(1),
          devices: Object.keys(r.rep).join(", "),
        })),
      );
    };

    // Heights of the floors that have a ceiling above them
    const getLevels = (x, z) => {
      if (levels) return levels;

      const baseY = rooms[0] ? rooms[0].floorY : 0;
      const top = (framingBox ? framingBox.max.y : baseY + 12) + 3;
      const list = getNearSolids(x, baseY + 5, z);

      rayOrigin.set(x, top, z);
      const hits = castSolids(rayOrigin, rayDown, top - baseY + 6, list);

      const ups = [];
      const downs = [];
      hits.forEach((hit) => {
        const ny = worldNormal(hit).y;
        if (ny > 0.5) ups.push(hit.point.y);
        else if (ny < -0.5) downs.push(hit.point.y);
      });

      const found = ups
        .filter((y) => downs.some((d) => d > y + 2 && d < y + 5.8))
        .sort((a, b) => a - b)
        .filter((y, i, arr) => i === 0 || y - arr[i - 1] > 1);

      levels = found.length ? found : [baseY];
      nearCache.x = Infinity;
      return levels;
    };

    // A free standing spot inside the room, looking down its longest side.
    const findRoomSpawn = (r) => {
      if (r.spawn !== undefined) return r.spawn;

      let best = null;

      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        for (const dist of [1.6, 2.2, 2.8]) {
          const x = r.center.x + Math.cos(ang) * dist;
          const z = r.center.z + Math.sin(ang) * dist;

          const f = sampleFloor(x, z, r.topY + 0.3, 3);
          if (f === null || Math.abs(f - r.floorY) > 0.5) continue;

          // must be indoors: a ceiling above the head
          if (ceilingDistance(x, f + 1.2, z, 4.5) === null) continue;

          let minClear = Infinity;
          let total = 0;
          let blocked = 0;
          let bestDir = null;

          for (let d = 0; d < 8; d++) {
            const da = (d / 8) * Math.PI * 2 + 0.2;
            const dx = Math.cos(da);
            const dz = Math.sin(da);
            let clear = 7;
            for (const h of [0.9, 1.5]) {
              const hit = wallDistance(x, f + h, z, dx, dz, 7);
              if (hit) clear = Math.min(clear, hit.distance);
            }
            if (clear < 7) blocked++;
            minClear = Math.min(minClear, clear);
            total += clear;
            if (!bestDir || clear > bestDir.clear) bestDir = { dx, dz, clear };
          }

          if (minClear < 0.8 || blocked < 5) continue;

          const score = total + minClear * 4;
          if (!best || score > best.score) {
            best = {
              score,
              x,
              z,
              floorY: f,
              yaw: Math.atan2(-bestDir.dx, -bestDir.dz),
            };
          }
        }
      }

      r.spawn = best;
      return best;
    };

    /* ------------------------------------------------------------------
       NAVIGATION: rooms and devices
    ------------------------------------------------------------------ */
    const goToRoom = (number) => {
      const floorNo = Math.floor(number / 100);
      const index = (number % 100) - 1;
      const r = rooms[index];

      if (!r || floorNo < 1) {
        setControlMessage(
          `Room ${number} model me nahi hai (model me rooms 101 se ${
            100 + rooms.length
          } tak hain).`,
        );
        return false;
      }

      const spawn = findRoomSpawn(r);
      if (!spawn) {
        setControlMessage(`Room ${number}: andar ki jagah nahi mili.`);
        return false;
      }

      const allLevels = getLevels(spawn.x, spawn.z);
      const floorY = allLevels[floorNo - 1];

      if (floorY === undefined) {
        setControlMessage(
          `Floor ${floorNo} model me nahi hai (model me ${allLevels.length} floors hain).`,
        );
        return false;
      }

      selectedRoomIndex = index;
      selectedDevice = null;
      setSelectedName(`Room ${number}`);
      setViewerMode("room");
      setHotelDashboardVisible(false);
      setSelectedStatusRoom(null);
      setSelectedControl("");
      setControlMessage("");

      startWalk(
        new THREE.Vector3(spawn.x, floorY + WALK.eye, spawn.z),
        spawn.yaw,
        -0.05,
      );
      // Highlight the source floor without leaving the 3D room mode.
      // setActiveNav emits a floor event, so restore room mode AFTER it.
      setActiveNav(`floor${floorNo}`);
      setViewerMode("room");
      setSelectedStatusRoom(null);
      return true;
    };

    // Stand 2-3 m from a device with a clear view of it and look at it.
    const viewDevice = (device) => {
      const r = rooms[device.room] || rooms[selectedRoomIndex];
      const floorY = device.floorY ?? (r ? r.floorY : device.box.min.y);
      const c = device.center;
      const isHigh = c.y - floorY > 2;
      const preferred = device.dist ?? (isHigh ? 2.6 : 2.0);

      let best = null;

      for (const dist of [preferred, preferred + 0.6, preferred - 0.5, 1.2]) {
        for (let a = 0; a < 16; a++) {
          const ang = (a / 16) * Math.PI * 2;
          const x = c.x + Math.cos(ang) * dist;
          const z = c.z + Math.sin(ang) * dist;

          const f = sampleFloor(x, z, floorY + 1.2, 2);
          if (f === null || Math.abs(f - floorY) > 0.4) continue;

          let clear = true;
          for (let d = 0; d < 8 && clear; d++) {
            const da = (d / 8) * Math.PI * 2;
            const hit = wallDistance(
              x,
              f + 1,
              z,
              Math.cos(da),
              Math.sin(da),
              0.5,
            );
            if (hit) clear = false;
          }
          if (!clear) continue;

          const eye = new THREE.Vector3(x, f + WALK.eye, z);
          if (segmentBlocked(eye, c, 0.4)) continue;

          const score = Math.abs(dist - preferred) + a * 0.001;
          if (!best || score < best.score) best = { score, eye };
        }
        if (best) break;
      }

      if (!best) {
        // fall back to the room entry point
        const spawn = r && findRoomSpawn(r);
        if (!spawn) return false;
        best = {
          eye: new THREE.Vector3(spawn.x, spawn.floorY + WALK.eye, spawn.z),
        };
      }

      const { yaw, pitch } = lookAtYawPitch(best.eye, c);
      startWalk(best.eye, yaw, pitch);
      selectedDevice = device;
      return true;
    };

    const goToType = (type) => {
      const title = DEVICE_TITLES[type] || type;
      let target = null;

      // the room you are in (or last entered), then the nearest one
      const roomIndex =
        currentRoom.index >= 0 ? currentRoom.index : selectedRoomIndex;
      const rep = rooms[roomIndex]?.rep[type];
      if (rep && (!walk.active || currentRoom.floorIdx === 0))
        target = rep.device;

      if (!target) {
        let bestDist = Infinity;
        devices.forEach((device) => {
          if (device.type !== type) return;
          const d = device.center.distanceTo(camera.position);
          if (d < bestDist) {
            bestDist = d;
            target = device;
          }
        });
      }

      if (!target) {
        setControlMessage(`${title} object is model me nahi mila.`);
        return;
      }

      setSelectedName(title);
      setSelectedControl(type);
      setControlMessage("");

      if (!viewDevice(target)) {
        setControlMessage(`${title} ke paas jaane ki jagah nahi mili.`);
      }
    };

    const goToArea = (id) => {
      const area = areas.find((a) => a.id === id);
      if (!area) return false;

      if (!viewDevice({ ...area, room: -1 })) {
        setControlMessage(`${area.label} ke paas jaane ki jagah nahi mili.`);
        return false;
      }

      selectedDevice = null;
      setSelectedName(area.label);
      setSelectedControl("");
      setControlMessage("");
      setActiveNav(area.id);
      return true;
    };

    const floorLevel = (floorNo) => {
      if (!rooms.length) return undefined;
      if (!levels) {
        const spawn = findRoomSpawn(rooms[0]);
        if (spawn) getLevels(spawn.x, spawn.z);
      }
      return levels ? levels[floorNo - 1] : undefined;
    };

    const makeEl = (style, text) => {
      const el = document.createElement("div");
      Object.assign(el.style, style);
      if (text) el.textContent = text;
      return el;
    };

    const planButton = (label, onClick) => {
      const b = document.createElement("button");
      b.textContent = label;
      Object.assign(b.style, {
        pointerEvents: "auto",
        border: "none",
        borderRadius: "999px",
        padding: "7px 13px",
        background: "rgba(15,23,42,0.88)",
        color: "#fff",
        font: "600 12px system-ui, sans-serif",
        cursor: "pointer",
      });
      b.onclick = onClick;
      return b;
    };

    const setPlanBar = (title, buttons) => {
      planBar.textContent = "";
      planBar.appendChild(
        makeEl(
          {
            padding: "7px 13px",
            borderRadius: "999px",
            background: "rgba(255,255,255,0.92)",
            color: "#111827",
            font: "700 12px system-ui, sans-serif",
            boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
          },
          title,
        ),
      );
      buttons.forEach((b) => planBar.appendChild(b));
      planBar.style.display = "flex";
    };

    const DOT_LABEL = { light: "L", ac: "AC", fridge: "F", microwave: "M" };

    // Floor plan: top view of the real model + one card per room
    const showFloor = (floorNo) => {
      const floorY = floorLevel(floorNo);
      if (floorY === undefined) {
        setControlMessage(`Floor ${floorNo} model me nahi hai.`);
        return false;
      }

      const xs = rooms.map((r) => r.center.x);
      const zs = rooms.map((r) => r.center.z);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cz = (Math.min(...zs) + Math.max(...zs)) / 2;

      topDown(
        new THREE.Vector3(cx, floorY, cz),
        Math.max(...zs) - Math.min(...zs) + 12,
        Math.max(...xs) - Math.min(...xs) + 14,
        floorY + 1.5,
      );

      planMode = { type: "floor", floorNo };
      setViewerMode("floor");
      setHotelDashboardVisible(false);
      setActiveFloorNo(floorNo);
      setSelectedStatusRoom(null);
      cardsLayer.textContent = "";
      planItems = [];

      rooms.forEach((r) => {
        const number = floorNo * 100 + r.index + 1;
        const el = makeEl({
          position: "absolute",
          left: "0",
          top: "0",
          width: "104px",
          display: "flex",
          flexDirection: "column",
          gap: "2px",
          pointerEvents: "auto",
          willChange: "transform",
          font: "10px Arial, sans-serif",
          textAlign: "center",
        });
        el.onmouseenter = () => {
          el.style.zIndex = "10";
        };
        el.onmouseleave = () => {
          el.style.zIndex = "";
        };
        const cardStyle = {
          width: "100%",
          border: "1px solid rgba(0,0,0,.10)",
          borderRadius: "5px",
          boxShadow: "0 1px 4px rgba(0,0,0,.18)",
          cursor: "pointer",
          boxSizing: "border-box",
          font: "inherit",
        };
        const roomButton = document.createElement("button");
        roomButton.type = "button";
        roomButton.textContent = `🚪 Room ${number} ›`;
        Object.assign(roomButton.style, cardStyle, {
          background: "rgba(255,255,255,.96)",
          color: "#202632",
          padding: "6px 2px",
          fontWeight: "600",
        });
        roomButton.title = `Enter Room ${number} · 3D View`;
        roomButton.onclick = (event) => {
          event.stopPropagation();
          goToRoom(number);
        };
        const statusButton = document.createElement("button");
        statusButton.type = "button";
        Object.assign(statusButton.style, cardStyle, {
          background: "rgba(255,255,255,.96)",
          minHeight: "39px",
          padding: "4px 2px",
          whiteSpace: "normal",
          lineHeight: "1.2",
        });
        statusButton.title = `Change Room ${number} status`;
        statusButton.onclick = (event) => {
          event.stopPropagation();
          setSelectedStatusRoom(number);
        };
        const serviceButton = document.createElement("button");
        serviceButton.type = "button";
        Object.assign(serviceButton.style, cardStyle, {
          padding: "5px 2px",
          minHeight: "27px",
        });
        serviceButton.title = `Toggle Room ${number} service`;
        serviceButton.onclick = (event) => {
          event.stopPropagation();
          setRoomServiceStates((prev) => ({
            ...prev,
            [number]: !prev[number],
          }));
        };
        el.append(roomButton, statusButton, serviceButton);
        cardsLayer.appendChild(el);
        planItems.push({
          el,
          pos: new THREE.Vector3(r.center.x, floorY + 1, r.center.z),
          key: "",
          refresh: () => {
            const status = roomStatusesRef.current[number] || "Vacant";
            const config = statusOptions.find((entry) => entry[0] === status);
            const color = config ? config[2] : "#15803d";
            const symbol = config ? config[1] : "⌂";
            statusButton.textContent = `${symbol}  ${status}`;
            statusButton.style.color = color;
            statusButton.style.background =
              status === "Room Service Request"
                ? "#fff8db"
                : status === "Occupied"
                  ? "#fff1f1"
                  : "rgba(255,255,255,.96)";
            const serviceOn = !!roomServiceRef.current[number];
            serviceButton.textContent = `⟳ Service ${serviceOn ? "ON" : "OFF"}`;
            serviceButton.style.background = serviceOn
              ? "#4fc59a"
              : "rgba(255,255,255,.94)";
            serviceButton.style.color = serviceOn ? "#064e3b" : "#334155";
          },
        });
      });

      cardsLayer.style.display = "block";
      setPlanBar(`Floor ${floorNo} plan`, [
        makeEl(
          {
            font: "500 12px system-ui, sans-serif",
            color: "#fff",
            padding: "7px 4px",
            textShadow: "0 1px 3px rgba(0,0,0,0.6)",
          },
          "Room number = 3D view · Status = popup · Room service = ON/OFF",
        ),
      ]);
      setActiveNav(`floor${floorNo}`);
      setSelectedName(`Floor ${floorNo}`);
      setSelectedControl("");
      setControlMessage("");
      return true;
    };

    // Room plan: top view of one suite with ON/OFF tiles on every device
    const showRoom = (number) => {
      const floorNo = Math.floor(number / 100);
      const r = rooms[(number % 100) - 1];
      const floorY = floorLevel(floorNo);

      if (!r || floorY === undefined) {
        setControlMessage(`Room ${number} model me nahi hai.`);
        return false;
      }

      topDown(
        new THREE.Vector3(r.center.x, floorY, r.center.z),
        9,
        13,
        floorY + 2,
      );

      planMode = { type: "room", floorNo, number };
      selectedRoomIndex = r.index;
      cardsLayer.textContent = "";
      planItems = [];

      const TILE_ICON = {
        light: "💡",
        ac: "❄️",
        fridge: "🧊",
        microwave: "🍲",
      };
      const types = floorNo === 1 ? Object.keys(r.rep) : [];

      ["light", "ac", "fridge", "microwave"]
        .filter((t) => types.includes(t))
        .forEach((type) => {
          const device = r.rep[type].device;
          const el = makeEl({
            position: "absolute",
            left: "0",
            top: "0",
            width: "86px",
            padding: "6px 4px",
            borderRadius: "6px",
            background: "#e5e7eb",
            color: "#111827",
            textAlign: "center",
            font: "600 12px system-ui, sans-serif",
            boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
            cursor: "pointer",
            pointerEvents: "auto",
            willChange: "transform",
          });
          el.onclick = () => toggleDevice(type);
          cardsLayer.appendChild(el);

          planItems.push({
            el,
            pos: new THREE.Vector3(
              device.center.x,
              floorY + 1,
              device.center.z,
            ),
            key: "",
            refresh: (data) => {
              const info = badgeInfo(type, data);
              el.style.background = info.tone === "ON" ? "#fde047" : "#e5e7eb";
              el.textContent = "";
              el.appendChild(makeEl({ fontSize: "18px" }, TILE_ICON[type]));
              el.appendChild(makeEl({}, DEVICE_TITLES[type]));
              el.appendChild(makeEl({ fontWeight: "700" }, info.value));
            },
          });
        });

      cardsLayer.style.display = "block";
      setPlanBar(`Room ${number}`, [
        planButton(`← Floor ${floorNo}`, () => showFloor(floorNo)),
        planButton("🚶 Andar jao (3D)", () => goToRoom(number)),
        ...(types.length
          ? []
          : [
              makeEl(
                {
                  font: "500 12px system-ui, sans-serif",
                  color: "#fff",
                  padding: "7px 4px",
                  textShadow: "0 1px 3px rgba(0,0,0,0.6)",
                },
                "Is floor par devices model me nahi hain",
              ),
            ]),
      ]);
      setActiveNav(`floor${floorNo}`);
      setSelectedName(`Room ${number}`);
      setSelectedControl("");
      setControlMessage("");
      return true;
    };

    apiRef.current = { goToRoom, goToType, goToArea, showFloor, showRoom };

    /* ------------------------------------------------------------------
       STATUS BADGES (live ON / OFF floating over each device of the room)
    ------------------------------------------------------------------ */
    const badges = new Map(); // device id -> { el, text, tone, selected, visible }

    const getBadge = (device) => {
      let badge = badges.get(device.id);
      if (badge) return badge;

      const el = document.createElement("div");
      Object.assign(el.style, {
        position: "absolute",
        left: "0",
        top: "0",
        display: "none",
        padding: "4px 9px",
        borderRadius: "999px",
        background: "rgba(15,23,42,0.88)",
        color: "#fff",
        font: "600 12px/1.3 system-ui, sans-serif",
        whiteSpace: "nowrap",
        boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
        border: "2px solid transparent",
        willChange: "transform",
      });
      badgeLayer.appendChild(el);

      badge = { el, text: "", tone: "", selected: false, visible: true };
      badges.set(device.id, badge);
      return badge;
    };

    const refreshCurrentRoom = () => {
      let floorIdx = 0;
      if (levels && levels.length > 1) {
        const feet = camera.position.y - WALK.eye;
        let bestDiff = Infinity;
        levels.forEach((y, i) => {
          const diff = Math.abs(feet - y);
          if (diff < bestDiff) {
            bestDiff = diff;
            floorIdx = i;
          }
        });
      }

      let bestRoom = -1;
      let bestDist = 11;
      rooms.forEach((r) => {
        const d = Math.hypot(
          camera.position.x - r.center.x,
          camera.position.z - r.center.z,
        );
        if (d < bestDist) {
          bestDist = d;
          bestRoom = r.index;
        }
      });

      if (bestRoom !== currentRoom.index || floorIdx !== currentRoom.floorIdx) {
        currentRoom = { index: bestRoom, floorIdx };
        setCurrentRoomLabel(
          bestRoom >= 0 ? `Room ${(floorIdx + 1) * 100 + bestRoom + 1}` : "",
        );
      }
    };

    const updateBadges = (now) => {
      if (!walk.active) return;

      if (now - lastRoomCheck > 250) {
        lastRoomCheck = now;
        refreshCurrentRoom();
      }

      const data = { ...latestDeviceDataRef.current };
      const demo = demoDeviceRef.current;
      for (const type of ["light", "ac", "fridge", "microwave"]) {
        data[type] = demo.power && demo[type] ? "ON" : "OFF";
      }
      const active = new Set();
      const r =
        currentRoom.index >= 0 && currentRoom.floorIdx === 0
          ? rooms[currentRoom.index]
          : null;

      if (r) {
        BADGE_TYPES.forEach((type) => {
          const rep = r.rep[type];
          if (rep) active.add(rep.device.id);
        });
      }

      const checkOcclusion = now - lastOcclusionCheck > 200;
      if (checkOcclusion) lastOcclusionCheck = now;

      badges.forEach((badge, id) => {
        if (!active.has(id)) badge.el.style.display = "none";
      });

      active.forEach((id) => {
        const device = devices[id];
        const badge = getBadge(device);

        const info = badgeInfo(device.type, data);
        const text = `${DEVICE_TITLES[device.type]}: ${info.value}`;

        if (badge.text !== text || badge.tone !== info.tone) {
          badge.text = text;
          badge.tone = info.tone;
          badge.el.textContent = "";

          const dot = document.createElement("span");
          Object.assign(dot.style, {
            display: "inline-block",
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            marginRight: "6px",
            background: TONE_COLORS[info.tone],
          });
          badge.el.appendChild(dot);
          badge.el.appendChild(document.createTextNode(text));
        }

        const isSelected = selectedDevice === device;
        if (badge.selected !== isSelected) {
          badge.selected = isSelected;
          badge.el.style.borderColor = isSelected ? "#fbbf24" : "transparent";
        }

        // position
        tmpV.copy(device.center);
        tmpV.y = Math.max(device.center.y, device.box.max.y) + 0.12;
        const dist = tmpV.distanceTo(camera.position);
        tmpV.project(camera);

        if (checkOcclusion) {
          badge.visible =
            dist < 12 && !segmentBlocked(camera.position, device.center, 0.45);
        }

        if (tmpV.z > 1 || tmpV.z < -1 || !badge.visible) {
          badge.el.style.display = "none";
          return;
        }

        const x = (tmpV.x * 0.5 + 0.5) * mount.clientWidth;
        const y = (-tmpV.y * 0.5 + 0.5) * mount.clientHeight;
        badge.el.style.display = "block";
        badge.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -130%)`;
      });
    };

    /* ------------------------------------------------------------------
       CLICK ON A DEVICE: go there (when far) / toggle it (when close)
    ------------------------------------------------------------------ */
    const handleCanvasClick = (event) => {
      if (planMode) return;
      // A drag (look around) must not count as a click on a device.
      if (dragMoved) {
        dragMoved = false;
        return;
      }

      const rect = renderer.domElement.getBoundingClientRect();

      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);

      const intersects = raycaster.intersectObject(modelGroup, true);

      // first device hit, unless a wall is in front of it
      let device = null;
      for (const hit of intersects) {
        if (hit.object.userData.isDevice) {
          device = devices[hit.object.userData.deviceId];
          break;
        }
        if (hit.object.userData.isSolid) break;
      }

      if (!device) return;

      const type = device.type;
      const title = DEVICE_TITLES[type] || type;

      setSelectedName(title);
      setSelectedControl(type);

      const close =
        walk.active && device.center.distanceTo(camera.position) < 3.5;

      if (close) {
        selectedDevice = device;
        toggleDevice(type);
      } else {
        viewDevice(device);
      }
    };

    /* ------------------------------------------------------------------
       LOADING
    ------------------------------------------------------------------ */
    const onModelLoaded = (gltf, modelPath) => {
      const loadedRoot = gltf.scene;
      pivot.add(loadedRoot);

      const items = prepareModel(loadedRoot);
      buildRegistry(items);

      floorLevel(1);
      buildNav();
      fitCameraToObject();
      setActiveNav("hotel");

      setLoadError("");
      setLoadedFile(modelPath);
      setModelReady(true);
    };

    const loadModel = (index = 0) => {
      if (disposed) return;

      if (index >= MODEL_CANDIDATES.length) {
        setLoadError(
          "GLB load failed. Put STAYBRIDGE_SUITES_2.glb in frontend/public/models/",
        );
        return;
      }

      const modelPath = MODEL_CANDIDATES[index];

      loader.load(
        modelPath,
        (gltf) => {
          if (disposed) return;
          onModelLoaded(gltf, modelPath);
        },
        (event) => {
          if (event.lengthComputable && event.total > 0) {
            setLoadProgress(Math.round((event.loaded / event.total) * 100));
          }
        },
        (error) => {
          console.warn("Failed to load", modelPath, error);
          loadModel(index + 1);
        },
      );
    };

    loadModel();

    /* ------------------------------------------------------------------
       NAVIGATION BAR (Hotel / Floors / Entrance / Stairs) + PLAN OVERLAYS
    ------------------------------------------------------------------ */
    const navRoot = document.createElement("div");
    Object.assign(navRoot.style, {
      position: "absolute",
      top: "10px",
      left: "10px",
      right: "10px",
      display: "flex",
      gap: "6px",
      overflowX: "auto",
      zIndex: 6,
      paddingBottom: "2px",
    });
    mount.appendChild(navRoot);

    const navButtons = new Map();

    function setActiveNav(id) {
      window.dispatchEvent(
        new CustomEvent("staybridge:view", { detail: { view: id } }),
      );
      navButtons.forEach((button, key) => {
        const active = key === id;
        button.style.background = active ? "#2563eb" : "rgba(255,255,255,0.94)";
        button.style.color = active ? "#fff" : "#111827";
      });
    }

    const addNav = (id, label, onClick) => {
      const button = document.createElement("button");
      button.textContent = label;
      Object.assign(button.style, {
        flex: "0 0 auto",
        border: "none",
        borderRadius: "8px",
        padding: "8px 13px",
        font: "600 13px system-ui, sans-serif",
        cursor: "pointer",
        boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
        background: "rgba(255,255,255,0.94)",
        color: "#111827",
      });
      button.onclick = onClick;
      navRoot.appendChild(button);
      navButtons.set(id, button);
    };

    const showHotel = () => {
      setSelectedStatusRoom(null);
      setViewerMode("hotel");
      setHotelDashboardVisible(true);
      fitCameraToObject();
      setSelectedName("None");
      setSelectedControl("");
      setActiveNav("hotel");
    };

    const buildNav = () => {
      navRoot.textContent = "";
      navButtons.clear();

      addNav("hotel", "🏨 Hotel", showHotel);
      (levels || []).forEach((_, i) => {
        addNav(`floor${i + 1}`, `Floor ${i + 1}`, () => showFloor(i + 1));
      });
      areas.forEach((area) => {
        addNav(area.id, area.label, () => goToArea(area.id));
      });
      setActiveNav("hotel");
    };

    const planBar = document.createElement("div");
    Object.assign(planBar.style, {
      position: "absolute",
      top: "54px",
      left: "10px",
      right: "10px",
      display: "none",
      gap: "6px",
      alignItems: "center",
      flexWrap: "wrap",
      zIndex: 6,
      pointerEvents: "none",
    });
    mount.appendChild(planBar);

    const cardsLayer = document.createElement("div");
    Object.assign(cardsLayer.style, {
      position: "absolute",
      inset: "0",
      overflow: "hidden",
      pointerEvents: "none",
      display: "none",
      zIndex: 4,
    });
    mount.appendChild(cardsLayer);

    /* ------------------------------------------------------------------
       INPUT
    ------------------------------------------------------------------ */
    const isTyping = (event) => {
      const tag = event.target?.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    };

    const handleKeyDown = (event) => {
      if (!walk.active || isTyping(event)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const key = event.key.toLowerCase();

      if (key === "f") {
        if (!event.repeat) setFly(!walk.fly);
        event.preventDefault();
        return;
      }

      const action = KEY_MAP[key];
      if (!action) return;

      keys[action] = true;
      if ((action === "up" || action === "down") && !walk.fly) setFly(true);

      event.preventDefault();
    };

    const handleKeyUp = (event) => {
      const action = KEY_MAP[event.key.toLowerCase()];
      if (!action) return;

      keys[action] = false;
      if (walk.active) event.preventDefault();
    };

    const handleWindowBlur = () => resetKeys();

    const handlePointerLockChange = () => {
      pointerLocked = document.pointerLockElement === renderer.domElement;
    };

    const rotateBy = (dx, dy) => {
      walk.yaw -= dx * WALK.mouse;
      walk.pitch = THREE.MathUtils.clamp(
        walk.pitch - dy * WALK.mouse,
        -1.45,
        1.45,
      );
      applyWalkRotation();
    };

    const handleMouseMove = (event) => {
      if (!walk.active || !pointerLocked) return;
      rotateBy(event.movementX, event.movementY);
    };

    // Click + drag to look around (also works with touch).
    const handlePointerDown = (event) => {
      if (!walk.active || pointerLocked) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;

      dragLook = { id: event.pointerId, x: event.clientX, y: event.clientY };
      dragMoved = false;
      renderer.domElement.focus();
      try {
        renderer.domElement.setPointerCapture(event.pointerId);
      } catch (error) {
        /* ignore */
      }
    };

    const handlePointerMove = (event) => {
      if (!dragLook || event.pointerId !== dragLook.id) return;

      const dx = event.clientX - dragLook.x;
      const dy = event.clientY - dragLook.y;

      if (!dragMoved && Math.hypot(dx, dy) < 4) return;

      dragMoved = true;
      dragLook.x = event.clientX;
      dragLook.y = event.clientY;
      rotateBy(dx, dy);
    };

    const handlePointerUp = (event) => {
      if (!dragLook || event.pointerId !== dragLook.id) return;
      dragLook = null;
      try {
        renderer.domElement.releasePointerCapture(event.pointerId);
      } catch (error) {
        /* ignore */
      }
    };

    const handleCanvasDoubleClick = () => {
      if (!walk.active) return;
      if (
        document.pointerLockElement !== renderer.domElement &&
        renderer.domElement.requestPointerLock
      ) {
        renderer.domElement.requestPointerLock();
      }
    };

    const handleWheel = (event) => {
      if (walk.active) {
        event.preventDefault();

        const move = event.deltaY > 0 ? -0.5 : 0.5;
        const dirX = -Math.sin(walk.yaw);
        const dirZ = -Math.cos(walk.yaw);

        if (walk.fly) {
          camera.position.x += dirX * move;
          camera.position.z += dirZ * move;
        } else {
          const [dx, dz] = resolveMove(
            camera.position.x,
            camera.position.z,
            walk.feetY,
            dirX * move,
            dirZ * move,
          );
          camera.position.x += dx;
          camera.position.z += dz;
        }
        return;
      }

      if (planMode) return;

      // zooming right into the building from outside enters the room
      const distance = camera.position.distanceTo(controls.target);
      if (event.deltaY < 0 && distance < 4 && rooms.length) {
        event.preventDefault();
        goToRoom(101 + selectedRoomIndex);
      }
    };

    renderer.domElement.addEventListener("click", handleCanvasClick);
    renderer.domElement.addEventListener("wheel", handleWheel, {
      passive: false,
    });
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointercancel", handlePointerUp);
    renderer.domElement.addEventListener("dblclick", handleCanvasDoubleClick);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("pointerlockchange", handlePointerLockChange);
    document.addEventListener("mousemove", handleMouseMove);

    /* ------------------------------------------------------------------
       GAME LOOP
    ------------------------------------------------------------------ */
    const updateWalk = (dt) => {
      // turning / looking with the keyboard
      if (keys.turnLeft) walk.yaw += WALK.turn * dt;
      if (keys.turnRight) walk.yaw -= WALK.turn * dt;
      if (keys.lookUp) walk.pitch += WALK.look * dt;
      if (keys.lookDown) walk.pitch -= WALK.look * dt;
      walk.pitch = THREE.MathUtils.clamp(walk.pitch, -1.45, 1.45);

      const sin = Math.sin(walk.yaw);
      const cos = Math.cos(walk.yaw);
      const pitchCos = Math.cos(walk.pitch);

      const forwardAxis = (keys.forward ? 1 : 0) - (keys.backward ? 1 : 0);
      const strafeAxis = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);

      // forward = (-sin, -cos), right = (cos, -sin)
      let mx = -sin * forwardAxis + cos * strafeAxis;
      let mz = -cos * forwardAxis - sin * strafeAxis;
      let my = 0;

      if (walk.fly) {
        mx = -sin * pitchCos * forwardAxis + cos * strafeAxis;
        mz = -cos * pitchCos * forwardAxis - sin * strafeAxis;
        my = forwardAxis * Math.sin(walk.pitch);
      }

      const len = Math.hypot(mx, my, mz);
      const speed = keys.run ? WALK.run : WALK.speed;

      if (walk.fly) {
        const fs = keys.run ? WALK.flySpeed * 2 : WALK.flySpeed;
        if (len > 0) {
          camera.position.x += (mx / len) * fs * dt;
          camera.position.y += (my / len) * fs * dt;
          camera.position.z += (mz / len) * fs * dt;
        }
        if (keys.up || keys.jump) camera.position.y += WALK.flyVertical * dt;
        if (keys.down) camera.position.y -= WALK.flyVertical * dt;
        walk.feetY = camera.position.y - WALK.eye;
      } else {
        if (len > 0) {
          const [dx, dz] = resolveMove(
            camera.position.x,
            camera.position.z,
            walk.feetY,
            (mx / len) * speed * dt,
            (mz / len) * speed * dt,
          );
          camera.position.x += dx;
          camera.position.z += dz;
        }

        if (keys.jump && walk.grounded) {
          walk.vy = WALK.jump;
          walk.grounded = false;
        }

        if (!walk.grounded) {
          walk.vy -= WALK.gravity * dt;
          walk.feetY += walk.vy * dt;
        }

        const far =
          WALK.stepUp +
          (walk.grounded ? WALK.stepDown : Math.max(1.5, -walk.vy * dt + 0.5));

        const floorY = sampleFloor(
          camera.position.x,
          camera.position.z,
          walk.feetY + WALK.stepUp,
          far,
        );

        if (walk.grounded) {
          if (floorY !== null) {
            walk.feetY = floorY;
          } else {
            walk.grounded = false;
          }
        } else if (floorY !== null && walk.feetY <= floorY && walk.vy <= 0) {
          walk.feetY = floorY;
          walk.vy = 0;
          walk.grounded = true;
        }

        const targetY = walk.feetY + WALK.eye;
        const blend = walk.grounded ? Math.min(1, dt * 16) : 1;
        camera.position.y += (targetY - camera.position.y) * blend;

        // fell out of the world: back to the room
        if (walkBounds && walk.feetY < walkBounds.min.y - 15) {
          goToRoom(101 + selectedRoomIndex);
          return;
        }
      }

      if (walkBounds) {
        camera.position.x = THREE.MathUtils.clamp(
          camera.position.x,
          walkBounds.min.x,
          walkBounds.max.x,
        );
        camera.position.z = THREE.MathUtils.clamp(
          camera.position.z,
          walkBounds.min.z,
          walkBounds.max.z,
        );
        camera.position.y = THREE.MathUtils.clamp(
          camera.position.y,
          walkBounds.min.y,
          walkBounds.max.y,
        );
      }

      applyWalkRotation();
    };

    const updatePlanUi = () => {
      camera.updateMatrixWorld();
      const data = { ...latestDeviceDataRef.current };
      const demo = demoDeviceRef.current;
      for (const type of ["light", "ac", "fridge", "microwave"]) {
        data[type] = demo.power && demo[type] ? "ON" : "OFF";
      }
      const key = JSON.stringify([
        data.light,
        data.ac,
        data.acTemp,
        data.fridge,
        data.microwave,
        roomCardRevision.current,
      ]);
      const w = mount.clientWidth;
      const h = mount.clientHeight;

      // Keep cards readable: distribute their screen positions without overlap.
      // This changes only the HTML overlays, not the GLB or room positions.
      const visibleCards = [];
      planItems.forEach((item) => {
        tmpV.copy(item.pos).project(camera);
        if (tmpV.z > 1 || tmpV.z < -1) {
          item.el.style.display = "none";
          return;
        }
        const x = (tmpV.x * 0.5 + 0.5) * w;
        const y = (-tmpV.y * 0.5 + 0.5) * h;
        visibleCards.push({ item, x, y, px: x, py: y });
      });
      // Work separately on upper and lower room rows so cards never switch sides.
      const rowGroups = [];
      visibleCards.sort((a, b) => a.y - b.y);
      visibleCards.forEach((card) => {
        let row = rowGroups.find((r) => Math.abs(r.mean - card.y) < 55);
        if (!row) {
          row = { mean: card.y, cards: [] };
          rowGroups.push(row);
        }
        row.cards.push(card);
        row.mean =
          row.cards.reduce((sum, c) => sum + c.y, 0) / row.cards.length;
      });
      const cardWidth = 104;
      const cardHeight = 100;
      const gap = 6;
      rowGroups.forEach((row) => {
        row.cards.sort((a, b) => a.x - b.x);
        const count = row.cards.length;
        const spacing = cardWidth + gap;
        const total = count * cardWidth + (count - 1) * gap;
        const meanX = row.cards.reduce((sum, c) => sum + c.x, 0) / count;
        const left = Math.max(8, Math.min(w - total - 8, meanX - total / 2));
        row.cards.forEach((card, i) => {
          card.px = left + cardWidth / 2 + i * spacing;
          card.py = Math.max(125, Math.min(h - cardHeight / 2 - 12, row.mean));
        });
      });
      // If two rows are close due to zoom/perspective, separate vertically too.
      for (let i = 1; i < rowGroups.length; i++) {
        const previous = rowGroups[i - 1];
        const current = rowGroups[i];
        const prevY = previous.cards[0]?.py ?? 0;
        const curY = current.cards[0]?.py ?? 0;
        if (curY - prevY < cardHeight + 8) {
          const nextY = Math.min(
            h - cardHeight / 2 - 12,
            prevY + cardHeight + 8,
          );
          current.cards.forEach((c) => {
            c.py = nextY;
          });
        }
      }
      visibleCards.forEach(({ item, px, py }) => {
        item.el.style.display = "flex";
        item.el.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px) translate(-50%, -50%)`;
        if (item.key !== key) {
          item.key = key;
          item.refresh(data);
        }
      });
    };

    const animate = () => {
      animationId = requestAnimationFrame(animate);
      const delta = Math.min(fpsClock.getDelta(), 0.05);

      if (walk.active) {
        controls.enabled = false;
        updateWalk(delta);
        updateBadges(performance.now());
      } else {
        controls.update();
        if (planMode) updatePlanUi();
      }

      renderer.render(scene, camera);
    };

    animate();

    const handleResize = () => {
      if (!mount.clientWidth || !mount.clientHeight) return;

      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(mount);
    window.addEventListener("resize", handleResize);

    return () => {
      disposed = true;
      apiRef.current = null;

      window.removeEventListener("resize", handleResize);
      resizeObserver.disconnect();

      renderer.domElement.removeEventListener("click", handleCanvasClick);
      renderer.domElement.removeEventListener("wheel", handleWheel);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("viewer:demo-devices", handleDemoLighting);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("pointercancel", handlePointerUp);
      renderer.domElement.removeEventListener(
        "dblclick",
        handleCanvasDoubleClick,
      );

      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener(
        "pointerlockchange",
        handlePointerLockChange,
      );
      document.removeEventListener("mousemove", handleMouseMove);

      exitPointerLock();
      if (animationId) cancelAnimationFrame(animationId);

      controls.dispose();
      renderer.dispose();

      [
        navRoot,
        planBar,
        cardsLayer,
        hud,
        padRoot,
        flyButton,
        badgeLayer,
      ].forEach((el) => {
        if (el && mount.contains(el)) mount.removeChild(el);
      });

      if (mount.contains(renderer.domElement))
        mount.removeChild(renderer.domElement);
    };
  }, []);

  const devices = [
    {
      id: "temperature",
      label: "Temperature",
      value: `${deviceData.temperature} °C`,
      type: "temperature",
    },
    {
      id: "motion",
      label: "Motion",
      value: deviceData.motion,
      type: "motion",
    },
    {
      id: "ldr",
      label: "LDR",
      value: deviceData.ldr,
      type: "ldr",
    },
    {
      id: "light",
      label: "Light",
      value: deviceData.light,
      type: "light",
    },
    {
      id: "ac",
      label: "Mitsubishi AC",
      value: deviceData.ac,
      type: "ac",
    },
    {
      id: "acTemp",
      label: "AC Temp",
      value: `${deviceData.acTemp} °C`,
      type: "ac",
    },
    {
      id: "fridge",
      label: "Fridge",
      value: deviceData.fridge || "OFF",
      type: "fridge",
    },
    {
      id: "microwave",
      label: "Microwave",
      value: deviceData.microwave || "OFF",
      type: "microwave",
    },
  ];

  const onOffCard = (title, type, current, onChange) => (
    <div className="control-card light-card">
      <h4>{title}</h4>
      <p>
        Current Status: <strong>{current || "OFF"}</strong>
      </p>

      <div className="btn-row">
        <button
          onClick={() => {
            goToDevice(type);
            onChange("ON");
          }}
          disabled={sending}
        >
          {title} ON
        </button>

        <button
          onClick={() => {
            goToDevice(type);
            onChange("OFF");
          }}
          disabled={sending}
        >
          {title} OFF
        </button>
      </div>
    </div>
  );

  return (
    <div
      className="viewer-page"
      style={{
        width: "100%",
        height: "100%",
        display: "block",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        ref={mountRef}
        className="viewer-3d"
        style={{
          width: "100%",
          height: "100%",
          position: "relative",
          minWidth: 0,
          flex: "none",
        }}
      />
      <HotelWeatherDashboard
        visible={hotelDashboardVisible}
        onNavigate={(target) => {
          if (target === "room")
            apiRef.current?.goToRoom(parseRoomNumber(room, floor) || 101);
          else if (target.startsWith("floor"))
            apiRef.current?.showFloor(Number(target.replace("floor", "")));
          else if (target === "entrance")
            apiRef.current?.goToArea?.("entrance");
          else if (target.startsWith("stairs"))
            apiRef.current?.goToArea?.(target);
        }}
      />

      {viewerMode === "room" && modelReady && (
        <div
          style={{
            position: "absolute",
            top: 112,
            right: 16,
            zIndex: 21,
            width: 250,
            maxHeight: "calc(100% - 155px)",
            overflowY: "auto",
            background: "rgba(255,255,255,.94)",
            color: "#1f2937",
            borderRadius: 14,
            padding: 14,
            boxShadow: "0 8px 28px rgba(0,0,0,.22)",
            fontFamily: "system-ui,sans-serif",
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 3 }}>
            Smart Room Controls
          </div>
          <div style={{ fontSize: 11, color: "#64748b", marginBottom: 10 }}>
            3D room · Interactive demo (not connected to hardware)
          </div>
          {[
            ["power", "Main Power"],
            ["light", "Lights"],
            ["ac", "Air Conditioner"],
            ["tv", "TV"],
            ["fridge", "Fridge"],
            ["microwave", "Microwave"],
            ["curtains", "Curtains (Open)"],
          ].map(([key, label]) => (
            <div
              key={key}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                borderBottom: "1px solid #e5e7eb",
                padding: "8px 0",
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
              <button
                type="button"
                onClick={() => changeRoomControl(key)}
                aria-pressed={roomControls[key]}
                style={{
                  minWidth: 58,
                  padding: "7px 10px",
                  border: 0,
                  borderRadius: 8,
                  color: "white",
                  fontWeight: 700,
                  cursor: "pointer",
                  background: roomControls[key] ? "#059669" : "#64748b",
                }}
              >
                {roomControls[key] ? "ON" : "OFF"}
              </button>
            </div>
          ))}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: 12,
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            <span>AC Temperature</span>
            <span>{roomTemp}°C</span>
          </div>
          <input
            aria-label="AC temperature"
            type="range"
            min="16"
            max="30"
            value={roomTemp}
            onChange={(e) => setRoomTemp(Number(e.target.value))}
            style={{ width: "100%" }}
          />
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>
            Red indicates OFF and green indicates ON for the 3D device labels.
            Controls are a demo, not connected to physical devices.
          </div>
        </div>
      )}
      {viewerMode === "floor" && modelReady && selectedStatusRoom != null && (
        <div
          style={{
            position: "absolute",
            top: 58,
            right: 12,
            bottom: 12,
            zIndex: 22,
            width: "min(350px, 35vw)",
            background: "rgba(255,255,255,.96)",
            border: "1px solid #d1d5db",
            boxShadow: "0 8px 25px rgba(0,0,0,.2)",
            display: "flex",
            flexDirection: "column",
            fontFamily: "Arial,sans-serif",
            color: "#262626",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 16px",
              borderBottom: "1px solid #bbb",
              fontWeight: 700,
            }}
          >
            <span>
              ⌂ &nbsp; Room Status{" "}
              {selectedStatusRoom ? `· ${selectedStatusRoom}` : ""}
            </span>
            <button
              type="button"
              onClick={() => setSelectedStatusRoom(null)}
              style={{
                border: 0,
                background: "transparent",
                cursor: "pointer",
                fontSize: 20,
              }}
            >
              ×
            </button>
          </div>
          <div style={{ padding: "10px 14px", fontSize: 12, color: "#64748b" }}>
            {selectedStatusRoom
              ? `Room ${selectedStatusRoom} · ${roomStatuses[selectedStatusRoom] || "Vacant"}`
              : "Floor plan par room number click karein, ya neeche room select karein."}
          </div>
          <div style={{ padding: "0 14px 10px" }}>
            <select
              aria-label="Select room"
              value={selectedStatusRoom || ""}
              onChange={(e) =>
                setSelectedStatusRoom(Number(e.target.value) || null)
              }
              style={{
                width: "100%",
                padding: 9,
                border: "1px solid #d1d5db",
                borderRadius: 6,
              }}
            >
              <option value="">Select room</option>
              {Array.from({ length: 50 }, (_, i) => {
                const base = activeFloorNo * 100;
                const n = base + i + 1;
                return (
                  <option key={n} value={n}>
                    Room {n} — {roomStatuses[n] || "Vacant"}
                  </option>
                );
              })}
            </select>
          </div>
          <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
            {statusOptions.map(([status, symbol, color]) => (
              <button
                key={status}
                type="button"
                disabled={!selectedStatusRoom}
                onClick={() => updateRoomStatus(status)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  width: "100%",
                  gap: 16,
                  padding: "14px 16px",
                  background:
                    selectedStatusRoom &&
                    roomStatuses[selectedStatusRoom] === status
                      ? "#e8f5ec"
                      : "transparent",
                  border: 0,
                  borderBottom: "1px solid #ddd",
                  textAlign: "left",
                  cursor: selectedStatusRoom ? "pointer" : "not-allowed",
                  opacity: selectedStatusRoom ? 1 : 0.6,
                  fontSize: 15,
                  color: "#252525",
                }}
              >
                <span
                  style={{
                    fontSize: 28,
                    color,
                    width: 34,
                    textAlign: "center",
                  }}
                >
                  {symbol}
                </span>
                {status}
              </button>
            ))}
          </div>
          <div style={{ padding: "8px 14px" }}>
            <button
              type="button"
              disabled={!selectedStatusRoom}
              onClick={() => apiRef.current?.goToRoom(selectedStatusRoom)}
              style={{
                width: "100%",
                padding: "10px",
                border: 0,
                borderRadius: 7,
                background: "#343a76",
                color: "white",
                cursor: "pointer",
              }}
            >
              Enter Room · 3D View
            </button>
          </div>
          <div
            style={{
              padding: "12px 16px",
              borderTop: "1px solid #ddd",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>Room service</span>
            <button
              type="button"
              disabled={!selectedStatusRoom}
              onClick={() =>
                setRoomServiceStates((prev) => ({
                  ...prev,
                  [selectedStatusRoom]: !prev[selectedStatusRoom],
                }))
              }
              style={{
                padding: "8px 18px",
                border: 0,
                borderRadius: 6,
                color: "white",
                background:
                  selectedStatusRoom && roomServiceStates[selectedStatusRoom]
                    ? "#16a34a"
                    : "#64748b",
              }}
            >
              {selectedStatusRoom && roomServiceStates[selectedStatusRoom]
                ? "ON"
                : "OFF"}
            </button>
          </div>
          <div style={{ fontSize: 11, color: "#64748b", padding: "7px 14px" }}>
            Demo room statuses (local session only)
          </div>
        </div>
      )}
      {controlMessage && (
        <div
          role="status"
          style={{
            position: "absolute",
            bottom: 16,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 20,
            background: "rgba(15,23,42,.9)",
            color: "white",
            padding: "10px 16px",
            borderRadius: 8,
            maxWidth: "90%",
          }}
        >
          {controlMessage}
        </div>
      )}
    </div>
  );
}
