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
  Clicking a device in the 3D room (or its button in "Smart Room Controls")
  flips the on-screen demo state: red/green badge + LED + glow / picture / wind.
  Set this to true to ALSO send the command to the real backend/hardware.
*/
const SEND_TO_HARDWARE = false;

// devices that can be switched ON / OFF from the 3D room
const SWITCHABLE = ["light", "ac", "fridge", "microwave", "tv"];

// how far (m) the camera stands from a device when you walk up to it
const VIEW_DIST = { microwave: 1.6, tv: 2.6, fridge: 2.3, ac: 3, light: 3 };

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

  tv: ["television"],

  motion: ["occupancysensor", "motionsensor"],

  temperature: ["sidetable2", "sidetable"],
};

// order matters: the first matching type wins
const DEVICE_TYPES = [
  "ac",
  "ldr",
  "fridge",
  "microwave",
  "tv",
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
  "tv",
  "temperature",
  "motion",
  "ldr",
];

const DEVICE_TITLES = {
  light: "Light",
  ac: "AC",
  fridge: "Fridge",
  microwave: "Microwave",
  tv: "TV",
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

// strong yellow default material = Revit door-swing / clearance volume
const isClearanceMesh = (mesh) => {
  const color = mesh.material && mesh.material.color;
  if (!color) return false;
  const hex = parseInt(color.getHexString(), 16);
  const r = hex >> 16;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  return r > 200 && g > 170 && b < 60;
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
    case "tv":
      return { value: onOff(data.tv), tone: onOff(data.tv) };
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
    light: true,
    ac: false,
    tv: false,
    fridge: false,
    microwave: false,
    curtains: true,
    power: true,
  });
  const [roomTemp, setRoomTemp] = useState(24);
  // Reads/writes the ref (not stale state) so 3D clicks and panel buttons agree.
  const changeRoomControl = (key) => {
    const next = {
      ...demoDeviceRef.current,
      [key]: !demoDeviceRef.current[key],
    };
    demoDeviceRef.current = next;
    setRoomControls(next);
    window.dispatchEvent(
      new CustomEvent("viewer:demo-devices", { detail: next }),
    );
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
  const roomTempRef = useRef(24);

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
    if (!SWITCHABLE.includes(type)) return;

    const demo = demoDeviceRef.current;
    if (demo.power === false && !demo[type]) {
      setControlMessage("Main Power OFF hai — pehle Main Power ON karo.");
      return;
    }

    const turnOn = !demo[type];
    changeRoomControl(type);
    setControlMessage(`${DEVICE_TITLES[type]} ${turnOn ? "ON" : "OFF"}`);

    if (SEND_TO_HARDWARE) {
      const state = turnOn ? "ON" : "OFF";
      if (type === "light") controlLight(state);
      else if (type === "ac") controlAC(state);
      else if (type === "fridge") controlFridge(state);
      else if (type === "microwave") controlMicrowave(state);
    }
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
      ambient.intensity = on ? 1.0 : 0.22;
      light1.intensity = on ? 1.5 : 0.25;
      light2.intensity = on ? 0.6 : 0.1;
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
    let windowsList = []; // [{ box }] real windows (for the curtains)
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
      const windowMap = new Map();
      const bedBoxes = [];
      const headBoxes = [];
      const bedMeshes = [];

      items.forEach(({ mesh, box }) => {
        const label = getLabel(mesh);
        const source = label || mesh.name;
        const compact = matchName(source);

        if (/^(king|queen|double|twin|single)?bed\d*$/.test(compact)) {
          bedBoxes.push(box);
          bedMeshes.push({ mesh, kind: "base" });
        }
        if (/^bedbackfor/.test(compact)) {
          headBoxes.push(box);
          bedMeshes.push({ mesh, kind: "head" });
        }

        const type = classifyName(source);

        if (
          !type &&
          /^window/.test(compact) &&
          !/louver|trim|windows$/.test(compact)
        ) {
          const wOwner = getLabelOwner(mesh);
          let w = windowMap.get(wOwner.uuid);
          if (!w) {
            w = { box: new THREE.Box3() };
            windowMap.set(wOwner.uuid, w);
          }
          w.box.union(box);
        }

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

      windowsList = [...windowMap.values()];

      // The Revit fridge family carries a yellow "door swing" clearance block.
      // It is not part of the fridge: hide it and measure the real body only.
      devices.forEach((device) => {
        if (device.type !== "fridge") return;
        const body = device.meshes.filter((m) => !isClearanceMesh(m));
        if (!body.length || body.length === device.meshes.length) return;

        device.meshes.forEach((m) => {
          if (body.includes(m)) return;
          m.visible = false;
          m.userData.isDevice = false;
        });
        device.meshes = body;
        device.box = new THREE.Box3();
        body.forEach((m) =>
          device.box.union(new THREE.Box3().setFromObject(m)),
        );
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
          size: box.getSize(new THREE.Vector3()),
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

        // which end of the bed is the headboard?
        let best = null;
        headBoxes.forEach((hb) => {
          const hc = hb.getCenter(new THREE.Vector3());
          const d = Math.hypot(hc.x - r.center.x, hc.z - r.center.z);
          if (d < 2.5 && (!best || d < best.d)) best = { d, hc };
        });
        if (best) {
          const dx = best.hc.x - r.center.x;
          const dz = best.hc.z - r.center.z;
          r.head =
            Math.abs(dx) > Math.abs(dz)
              ? new THREE.Vector3(Math.sign(dx), 0, 0)
              : new THREE.Vector3(0, 0, Math.sign(dz));
        }
      });
      styleBed(bedMeshes);

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

          // furniture/appliances are not "solid": keep them out of the shot
          const sight = c.clone().sub(eye);
          const sightLen = sight.length();
          sight.divideScalar(sightLen);
          const sightRay = new THREE.Ray(eye, sight);
          const hidden = devices.some((other) => {
            if (other === device) return false;
            if (other.type === "light" || other.type === "motion") return false;
            if (other.box.distanceToPoint(eye) < 0.45) return true;
            const hit = sightRay.intersectBox(other.box, new THREE.Vector3());
            return !!hit && hit.distanceTo(eye) < sightLen - 0.15;
          });
          if (hidden) continue;

          let score = Math.abs(dist - preferred) + a * 0.001;
          if (device.front) {
            // stand in front of the device, not behind it
            score +=
              (1 -
                (Math.cos(ang) * device.front.x +
                  Math.sin(ang) * device.front.z)) *
              0.5;
          }
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
      if (type === "curtains") {
        const ri =
          currentRoom.index >= 0 ? currentRoom.index : selectedRoomIndex;
        if (!fx.built.has(ri)) buildRoomFx(ri);
        const it = fx.items.find((i) => i.type === "curtains" && i.room === ri);
        if (!it) {
          setControlMessage("Is room me window / curtain nahi mila.");
          return;
        }
        setSelectedName("Curtains");
        setSelectedControl("");
        setControlMessage("");
        viewDevice({
          center: it.center.clone(),
          room: ri,
          front: it.front.clone(),
          dist: 2.8,
          box: new THREE.Box3().setFromCenterAndSize(
            it.center,
            new THREE.Vector3(1, 1, 1),
          ),
        });
        return;
      }

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

      if (target.dist == null && VIEW_DIST[type]) target.dist = VIEW_DIST[type];
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
        tv: "📺",
      };
      const types = floorNo === 1 ? Object.keys(r.rep) : [];

      ["light", "ac", "fridge", "microwave", "tv"]
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
       LIVE DEVICE EFFECTS  (what ON / OFF looks like inside the room)
         microwave ON : glowing window + warm light, turntable food
         TV ON        : moving picture on the screen + soft blue light
         AC ON        : wind / cool air flowing out of the AC
         Light ON     : glow around every ceiling fixture
         every device : small LED on the device itself (red = OFF, green = ON)
       Only the room you are standing in is drawn. State comes from
       demoDeviceRef (the Smart Room Controls panel / 3D clicks).
    ------------------------------------------------------------------ */
    const fx = {
      group: new THREE.Group(),
      items: [],
      built: new Set(),
      glowTex: null,
      tvCanvas: null,
      tvTex: null,
      tvLast: 0,
    };
    fx.group.name = "device-effects";
    scene.add(fx.group);

    const FX_LED_ON = 0x22ff66;
    const FX_LED_OFF = 0xff2a2a;

    const getGlowTexture = () => {
      if (fx.glowTex) return fx.glowTex;
      const c = document.createElement("canvas");
      c.width = 64;
      c.height = 64;
      const g = c.getContext("2d");
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(0.25, "rgba(255,255,255,0.85)");
      grad.addColorStop(0.6, "rgba(255,255,255,0.25)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      fx.glowTex = new THREE.CanvasTexture(c);
      return fx.glowTex;
    };

    const makeGlow = (color, size, opacity) => {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: getGlowTexture(),
          color,
          transparent: true,
          opacity,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      sprite.scale.set(size, size, 1);
      sprite.renderOrder = 20;
      sprite.raycast = () => {};
      return sprite;
    };

    const getTvTexture = () => {
      if (fx.tvTex) return fx.tvTex;
      fx.tvCanvas = document.createElement("canvas");
      fx.tvCanvas.width = 256;
      fx.tvCanvas.height = 144;
      fx.tvTex = new THREE.CanvasTexture(fx.tvCanvas);
      fx.tvTex.colorSpace = THREE.SRGBColorSpace;
      return fx.tvTex;
    };

    // A simple animated "TV programme"
    const drawTv = (t) => {
      const c = fx.tvCanvas;
      const g = c.getContext("2d");
      const W = c.width;
      const H = c.height;
      const hue = (t * 28) % 360;

      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, `hsl(${hue},70%,46%)`);
      grad.addColorStop(1, `hsl(${(hue + 90) % 360},75%,28%)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);

      for (let i = 0; i < 6; i++) {
        const x = (Math.sin(t * 0.7 + i * 1.9) * 0.5 + 0.5) * W;
        const y = (Math.cos(t * 0.5 + i * 2.3) * 0.5 + 0.5) * H;
        const r = 16 + 14 * Math.sin(t * 1.3 + i);
        g.fillStyle = `hsla(${(hue + i * 55) % 360},90%,72%,0.5)`;
        g.beginPath();
        g.arc(x, y, Math.abs(r), 0, Math.PI * 2);
        g.fill();
      }

      g.fillStyle = "rgba(0,0,0,0.55)";
      g.fillRect(0, H - 30, W, 30);
      g.fillStyle = "#ffffff";
      g.font = "bold 16px sans-serif";
      g.fillText("HOTEL TV", 10, H - 10);
      g.fillStyle = "#ef4444";
      g.fillRect(W - 54, H - 24, 44, 18);
      g.fillStyle = "#ffffff";
      g.font = "bold 12px sans-serif";
      g.fillText("LIVE", W - 47, H - 10);

      fx.tvTex.needsUpdate = true;
    };

    // Where is the device facing, and how big is its front face?
    const deviceFrame = (device, type) => {
      const r = rooms[device.room];
      let size = device.box.getSize(new THREE.Vector3());
      let c = device.center.clone();
      let panelAxis = null;

      if (type === "tv") {
        // the TV object also contains its stand: find the flat panel itself
        let bestArea = 0;
        device.meshes.forEach((mesh) => {
          const b = new THREE.Box3().setFromObject(mesh);
          const s3 = b.getSize(new THREE.Vector3());
          const axis = s3.x < s3.z ? "x" : "z";
          const thin = Math.min(s3.x, s3.z);
          const wide = Math.max(s3.x, s3.z);
          const area = wide * s3.y;
          if (thin < 0.25 && s3.y > 0.3 && s3.y < 1.6 && area > bestArea) {
            bestArea = area;
            panelAxis = axis;
            size = s3;
            c = b.getCenter(new THREE.Vector3());
          }
        });
      }

      const toRoom = new THREE.Vector3(r.center.x - c.x, 0, r.center.z - c.z);
      if (toRoom.lengthSq() < 1e-6) toRoom.set(0, 0, 1);
      toRoom.normalize();

      let f = null;
      if (type === "tv") {
        // a flat screen is thin: its normal is the thin horizontal axis
        if (panelAxis) {
          f =
            panelAxis === "x"
              ? new THREE.Vector3(1, 0, 0)
              : new THREE.Vector3(0, 0, 1);
        }
      } else if (
        type === "ac" &&
        Math.min(size.x, size.z) < 0.25 &&
        Math.max(size.x, size.z) > Math.min(size.x, size.z) * 2
      ) {
        f =
          size.x < size.z
            ? new THREE.Vector3(1, 0, 0)
            : new THREE.Vector3(0, 0, 1);
      } else {
        // fixtures stand against a wall: they face away from the nearest one
        let best = null;
        for (let a = 0; a < 16; a++) {
          const ang = (a / 16) * Math.PI * 2;
          const dx = Math.cos(ang);
          const dz = Math.sin(ang);
          const hit = wallDistance(c.x, c.y, c.z, dx, dz, 1.6);
          if (hit && (!best || hit.distance < best.d)) {
            best = { d: hit.distance, dx, dz };
          }
        }
        if (best) f = new THREE.Vector3(-best.dx, 0, -best.dz);
      }

      if (!f) f = toRoom.clone();
      if (f.dot(toRoom) < 0) f.negate();

      const right = new THREE.Vector3(f.z, 0, -f.x);
      return {
        c,
        f,
        right,
        size,
        half: (Math.abs(f.x) * size.x + Math.abs(f.z) * size.z) / 2,
        width: Math.abs(right.x) * size.x + Math.abs(right.z) * size.z,
        yaw: Math.atan2(f.x, f.z),
      };
    };

    // point in front of the device: `ahead` m off its face, `side` m to the right
    const frameAt = (fr, ahead, side, up) =>
      fr.c
        .clone()
        .addScaledVector(fr.f, fr.half + ahead)
        .addScaledVector(fr.right, side)
        .add(new THREE.Vector3(0, up, 0));

    const makeDeviceFx = (type, device, roomIndex) => {
      const fr = deviceFrame(device, type);
      device.front = fr.f.clone();

      const group = new THREE.Group();
      group.visible = false;
      fx.group.add(group);

      const item = {
        type,
        room: roomIndex,
        group,
        level: 0,
        tick: null,
        led: null,
        frame: fr,
      };

      // status LED (red OFF / green ON) on the device itself
      const ledSpec = {
        microwave: [0.02, fr.width * 0.38, fr.size.y * 0.25, 0.07],
        tv: [0.02, fr.width * 0.46, -fr.size.y * 0.5 + 0.03, 0.07],
        ac: [0.04, fr.width * 0.38, 0, 0.1],
        fridge: [0.03, fr.width * 0.3, fr.size.y * 0.2, 0.07],
      }[type];
      if (ledSpec) {
        const led = makeGlow(FX_LED_OFF, ledSpec[3], 1);
        led.position.copy(frameAt(fr, ledSpec[0], ledSpec[1], ledSpec[2]));
        group.add(led);
        item.led = led;
      }

      if (type === "microwave") {
        const winX = -fr.width * 0.17;
        const win = new THREE.Mesh(
          new THREE.PlaneGeometry(fr.width * 0.5, fr.size.y * 0.62),
          new THREE.MeshBasicMaterial({
            color: 0xff9a3c,
            transparent: true,
            opacity: 0,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
        );
        win.position.copy(frameAt(fr, 0.012, winX, 0));
        win.rotation.y = fr.yaw;
        win.renderOrder = 19;

        const food = new THREE.Mesh(
          new THREE.PlaneGeometry(fr.width * 0.2, fr.size.y * 0.24),
          new THREE.MeshBasicMaterial({
            color: 0x5a2a0a,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
        );
        food.rotation.y = fr.yaw;
        food.renderOrder = 21;

        const halo = makeGlow(0xff9a2e, Math.max(fr.width, fr.size.y) * 2.6, 0);
        halo.position.copy(frameAt(fr, 0.2, winX, 0));

        group.add(win, food, halo);
        item.tick = (level, t) => {
          const flick =
            0.86 + 0.14 * Math.sin(t * 23) + 0.04 * Math.sin(t * 61);
          win.material.opacity = level * 0.8 * flick;
          halo.material.opacity = level * 0.5 * flick;
          food.material.opacity = level * 0.55;
          food.position.copy(
            frameAt(
              fr,
              0.02,
              winX + Math.sin(t * 1.6) * fr.width * 0.07,
              -fr.size.y * 0.12,
            ),
          );
          win.visible = halo.visible = food.visible = level > 0.01;
        };
      } else if (type === "tv") {
        const screen = new THREE.Mesh(
          new THREE.PlaneGeometry(fr.width * 0.92, fr.size.y * 0.84),
          new THREE.MeshBasicMaterial({
            map: getTvTexture(),
            transparent: true,
            opacity: 0,
            toneMapped: false,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
        );
        screen.position.copy(frameAt(fr, 0.012, 0, 0));
        screen.rotation.y = fr.yaw;
        screen.renderOrder = 19;

        const halo = makeGlow(0x6aa8ff, fr.width * 2.4, 0);
        halo.position.copy(frameAt(fr, 0.3, 0, 0));

        group.add(screen, halo);
        item.tick = (level, t) => {
          screen.material.opacity = level;
          halo.material.opacity =
            level * 0.35 * (0.92 + 0.08 * Math.sin(t * 9));
          screen.visible = halo.visible = level > 0.01;
        };
      } else if (type === "ac") {
        // Soft, translucent air "beams" fanning down from the AC (like the
        // light-ray look of an AC advert). No particles, nothing bold.
        const M = 7; // beams
        const K = 10; // rows along a beam
        const reach = 0.9; // metres forward at the end of a beam
        const drop = 1.7; // metres down at the end of a beam
        const beams = [];

        for (let m = 0; m < M; m++) {
          const side0 = (m / (M - 1) - 0.5) * fr.width * 0.8;
          const w0 = (fr.width / M) * 0.55;
          const positions = [];
          const uvs = [];
          const index = [];

          // two crossed strips per beam so it also reads from the side
          [0, 1].forEach((strip) => {
            const base = positions.length / 3;
            for (let j = 0; j <= K; j++) {
              const v = j / K;
              const half = (w0 + w0 * 1.6 * v) / 2;
              const c = frameAt(
                fr,
                0.06 + v * reach * (0.7 + 0.3 * Math.cos(m * 1.3)),
                side0 * (1 + 0.9 * v),
                -fr.size.y * 0.2 - v * drop,
              );
              const axis = strip === 0 ? fr.right : fr.f;
              const a = c.clone().addScaledVector(axis, -half);
              const b = c.clone().addScaledVector(axis, half);
              positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
              uvs.push(0, v, 1, v);
            }
            for (let j = 0; j < K; j++) {
              const i0 = base + j * 2;
              index.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
            }
          });

          const geo = new THREE.BufferGeometry();
          geo.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(positions, 3),
          );
          geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
          geo.setIndex(index);

          const mat = new THREE.ShaderMaterial({
            uniforms: {
              time: { value: 0 },
              level: { value: 0 },
              phase: { value: m * 1.9 },
              tint: { value: new THREE.Color(0.86, 0.94, 1) },
            },
            vertexShader: `
              varying vec2 vUv;
              void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
              }`,
            fragmentShader: `
              uniform float time;
              uniform float level;
              uniform float phase;
              uniform vec3 tint;
              varying vec2 vUv;
              void main() {
                float edge = smoothstep(0.0, 0.4, vUv.x) * smoothstep(1.0, 0.6, vUv.x);
                float fade = smoothstep(0.0, 0.1, vUv.y) * pow(1.0 - vUv.y, 1.5);
                float shimmer = 0.7 + 0.3 * sin(time * 0.9 + phase + vUv.y * 4.0);
                gl_FragColor = vec4(tint, edge * fade * shimmer * level * 0.2);
              }`,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
          });

          const mesh = new THREE.Mesh(geo, mat);
          mesh.frustumCulled = false;
          mesh.renderOrder = 22;
          mesh.raycast = () => {};
          group.add(mesh);
          beams.push(mat);
        }

        item.tick = (level, t) => {
          const visible = level > 0.01;
          // colder set-point = slightly stronger airflow
          const strength = THREE.MathUtils.clamp(
            (30 - roomTempRef.current) / 14,
            0,
            1,
          );
          beams.forEach((mat) => {
            mat.uniforms.time.value = t;
            mat.uniforms.level.value = level * (0.75 + 0.25 * strength);
          });
          group.children.forEach((child) => {
            if (child.material && child.material.uniforms)
              child.visible = visible;
          });
        };
      }
      // fridge: LED only

      return item;
    };

    const makeLightFx = (r) => {
      const group = new THREE.Group();
      group.visible = false;
      fx.group.add(group);

      const halos = [];
      devices.forEach((d) => {
        if (d.type !== "light" || d.room !== r.index) return;
        const up = d.center.y - r.floorY;
        if (up < 1.2 || up > 4) return;
        const halo = makeGlow(0xffe2a8, 0.85, 0);
        halo.position.set(d.center.x, d.center.y - 0.12, d.center.z);
        group.add(halo);
        halos.push(halo);
      });

      return {
        type: "light",
        room: r.index,
        group,
        level: 0,
        led: null,
        tick: (level) => {
          halos.forEach((h) => {
            // no white-out when the camera is right under a fixture
            const near = THREE.MathUtils.clamp(
              (h.position.distanceTo(camera.position) - 0.5) / 1.2,
              0,
              1,
            );
            h.material.opacity = level * 0.32 * near;
            h.visible = level > 0.01;
          });
        },
      };
    };

    /* ------------------------------------------------------------------
       REAL-LOOK ROOM: bed linen, pillows, headboard, rug, curtains, sky
       (everything procedural: no extra files / images needed)
    ------------------------------------------------------------------ */
    fx.fabric = {};
    fx.lamps = [];
    fx.plainBg = scene.background;
    fx.skyOn = false;
    fx.skyTex = null;

    // small woven-fabric canvas texture
    const getFabric = (name, base, shade, repeat) => {
      if (fx.fabric[name]) return fx.fabric[name];
      const c = document.createElement("canvas");
      c.width = 128;
      c.height = 128;
      const g = c.getContext("2d");
      g.fillStyle = base;
      g.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 128; i += 2) {
        g.fillStyle = `rgba(${shade},0.07)`;
        g.fillRect(i, 0, 1, 128);
        g.fillRect(0, i, 128, 1);
      }
      for (let i = 0; i < 1400; i++) {
        g.fillStyle = `rgba(${shade},${(Math.random() * 0.08).toFixed(3)})`;
        g.fillRect(Math.random() * 128, Math.random() * 128, 1.5, 1.5);
      }
      const tex = new THREE.CanvasTexture(c);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(repeat, repeat);
      tex.colorSpace = THREE.SRGBColorSpace;
      fx.fabric[name] = tex;
      return tex;
    };

    const fabricMat = (name, base, shade, repeat, color = 0xffffff) =>
      new THREE.MeshStandardMaterial({
        color,
        map: getFabric(name, base, shade, repeat),
        roughness: 0.95,
        metalness: 0,
        side: THREE.DoubleSide,
      });

    // soft cloth wrinkles
    const wrinkle = (x, z) =>
      0.5 * Math.sin(x * 7.1 + z * 3.3) +
      0.35 * Math.sin(x * 13.7 - z * 5.9 + 1.2) +
      0.25 * Math.sin(z * 9.3 + x * 2.1 + 2.4);

    // Grey upholstered headboard, dark frame (the GLB bed is plain grey)
    const styleBed = (list) => {
      list.forEach(({ mesh, kind }) => {
        mesh.material =
          kind === "head"
            ? fabricMat("headboard", "#8d877b", "60,55,45", 6)
            : fabricMat("bedbase", "#6d6862", "40,38,35", 4);
      });
    };

    // Cloth lying on the mattress; edges that hang down over the bed sides/foot.
    //  x: across the bed, z: along the bed (head = -L/2, foot = +L/2)
    const drapedCloth = (W, z0, z1, hangFoot, top, material, hang = 0.34) => {
      const segX = 44;
      const segZ = Math.max(8, Math.round((z1 - z0) * 28));
      const pos = [];
      const uv = [];
      const idx = [];
      const edge = 0.11;
      for (let j = 0; j <= segZ; j++) {
        for (let i = 0; i <= segX; i++) {
          const x = (i / segX - 0.5) * W;
          const z = z0 + (j / segZ) * (z1 - z0);
          const dx = Math.max(0, Math.abs(x) - (W / 2 - edge)) / edge;
          const dz = hangFoot ? Math.max(0, z - (z1 - edge)) / edge : 0;
          const e = Math.min(1, Math.max(dx, dz));
          const y = top + 0.011 * wrinkle(x, z) - hang * Math.pow(e, 1.7);
          pos.push(x, y, z);
          uv.push(x * 1.4, z * 1.4);
        }
      }
      for (let j = 0; j < segZ; j++) {
        for (let i = 0; i < segX; i++) {
          const a = j * (segX + 1) + i;
          const b = a + 1;
          const c = a + segX + 1;
          const d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, material);
      mesh.raycast = () => {};
      return mesh;
    };

    // Puffy pillow / cushion (top surface only, the bottom rests on the bed)
    const makePillow = (hw, hd, h, material) => {
      const N = 22;
      const pos = [];
      const uv = [];
      const idx = [];
      for (let j = 0; j <= N; j++) {
        for (let i = 0; i <= N; i++) {
          const u = (i / N) * 2 - 1;
          const v = (j / N) * 2 - 1;
          const y =
            h *
            Math.pow(Math.max(0, 1 - u * u), 0.45) *
            Math.pow(Math.max(0, 1 - v * v), 0.45) *
            (1 + 0.06 * wrinkle(u * 2, v * 2));
          pos.push(u * hw, y, v * hd);
          uv.push(u * 0.5 + 0.5, v * 0.5 + 0.5);
        }
      }
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const a = j * (N + 1) + i;
          const b = a + 1;
          const c = a + N + 1;
          const d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, material);
      mesh.raycast = () => {};
      return mesh;
    };

    // walnut wood grain
    const getWood = () => {
      if (fx.fabric.wood) return fx.fabric.wood;
      const c = document.createElement("canvas");
      c.width = 256;
      c.height = 256;
      const g = c.getContext("2d");
      g.fillStyle = "#6a4528";
      g.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 160; i++) {
        const y = Math.random() * 256;
        const dark = Math.random() < 0.6;
        g.strokeStyle = dark
          ? `rgba(40,22,10,${(0.1 + Math.random() * 0.25).toFixed(2)})`
          : `rgba(150,105,60,${(0.08 + Math.random() * 0.15).toFixed(2)})`;
        g.lineWidth = 0.6 + Math.random() * 1.6;
        g.beginPath();
        g.moveTo(0, y);
        for (let x = 0; x <= 256; x += 32) {
          g.lineTo(x, y + Math.sin(x * 0.05 + i) * 2.2);
        }
        g.stroke();
      }
      const tex = new THREE.CanvasTexture(c);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(1, 1);
      tex.colorSpace = THREE.SRGBColorSpace;
      fx.fabric.wood = tex;
      return tex;
    };

    // Padded, channel-tufted headboard that sits in front of the flat GLB panel
    const makeHeadboard = (W, yBottom, yTop, zFace, material) => {
      const segX = 72;
      const segY = 22;
      const w = W + 0.08;
      const h = yTop - yBottom;
      const pos = [];
      const uv = [];
      const idx = [];
      const spacing = 0.33;
      for (let j = 0; j <= segY; j++) {
        for (let i = 0; i <= segX; i++) {
          const x = (i / segX - 0.5) * w;
          const y = yBottom + (j / segY) * h;
          const ex = Math.abs(x) / (w / 2);
          const ey = Math.abs(y - (yBottom + h / 2)) / (h / 2);
          const edge = Math.max(ex, ey);
          const pad = 0.075 * (1 - Math.pow(edge, 4));
          const phase = (((x + w / 2) % spacing) + spacing) % spacing;
          const dist = Math.min(phase, spacing - phase);
          const groove = 0.024 * Math.exp(-Math.pow(dist / 0.015, 2));
          pos.push(x, y, zFace + pad - groove * (1 - Math.pow(edge, 6)));
          uv.push(x * 1.6, y * 1.6);
        }
      }
      for (let j = 0; j < segY; j++) {
        for (let i = 0; i < segX; i++) {
          const a = j * (segX + 1) + i;
          const b = a + 1;
          const c = a + segX + 1;
          const d = c + 1;
          idx.push(a, b, c, b, d, c);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, material);
      mesh.raycast = () => {};
      return mesh;
    };

    // Round brass-footed table lamp with a glowing shade
    const makeLamp = (x, y, z, roomIndex) => {
      const lamp = new THREE.Group();
      lamp.position.set(x, y, z);
      const brass = new THREE.MeshStandardMaterial({
        color: 0xb08d57,
        roughness: 0.35,
        metalness: 0.85,
      });
      const foot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.08, 0.025, 20),
        brass,
      );
      foot.position.y = 0.0125;
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.014, 0.014, 0.22, 10),
        brass,
      );
      stem.position.y = 0.13;
      const shadeMat = new THREE.MeshStandardMaterial({
        color: 0xfff1d6,
        emissive: 0xffd9a0,
        emissiveIntensity: 0.12,
        roughness: 0.85,
      });
      const shade = new THREE.Mesh(
        new THREE.SphereGeometry(0.13, 24, 16),
        shadeMat,
      );
      shade.scale.set(1, 0.88, 1);
      shade.position.y = 0.34;
      [foot, stem, shade].forEach((m) => {
        m.raycast = () => {};
        lamp.add(m);
      });
      const halo = makeGlow(0xffd29a, 1.0, 0);
      halo.position.set(x, y + 0.34, z);
      fx.group.add(lamp, halo);
      fx.lamps.push({ room: roomIndex, shade, halo, level: 0 });
    };

    // Warm wooden bedside tables with a lamp on each, padded headboard
    const dressBedside = (r) => {
      const woodMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: getWood(),
        roughness: 0.55,
        metalness: 0.05,
      });
      devices.forEach((d) => {
        if (d.type !== "temperature" || d.room !== r.index) return;
        if (Math.abs(d.center.y - r.floorY) > 1.2) return;
        const dist = Math.hypot(
          d.center.x - r.center.x,
          d.center.z - r.center.z,
        );
        if (dist > 2.4 || dist < 0.6) return;

        d.meshes.forEach((m) => {
          m.material = woodMat;
        });
        makeLamp(d.center.x, d.box.max.y, d.center.z, r.index);
      });
    };

    // White duvet, beige runner, pillows, olive cushions and a grey rug,
    // laid out like the reference room plan.
    const buildBedding = (r) => {
      if (!r.head || !r.size) return;

      const foot = r.head.clone().negate();
      const across =
        Math.abs(r.head.x) * r.size.z + Math.abs(r.head.z) * r.size.x;
      const length =
        Math.abs(r.head.x) * r.size.x + Math.abs(r.head.z) * r.size.z;
      const W = across;
      const L = length;
      const yaw = Math.atan2(foot.x, foot.z);

      const bed = new THREE.Group();
      bed.position.set(r.center.x, r.topY, r.center.z);
      bed.rotation.y = yaw;
      fx.group.add(bed);

      const white = fabricMat("linen", "#f3f1ec", "120,115,105", 1);
      const runnerMat = fabricMat("runner", "#b3a58c", "70,60,45", 1);
      const oliveMat = fabricMat("olive", "#6f7b4c", "30,40,20", 1);

      // duvet from just below the pillows to the foot (hangs over 3 sides)
      bed.add(
        drapedCloth(W + 0.05, -L / 2 + 0.6, L / 2 + 0.03, true, 0.075, white),
      );
      // turned-down sheet band across the bed
      bed.add(
        drapedCloth(
          W + 0.04,
          -L / 2 + 0.56,
          -L / 2 + 0.9,
          false,
          0.092,
          white,
          0.2,
        ),
      );
      // beige runner over the foot third
      bed.add(
        drapedCloth(
          W + 0.07,
          L / 2 - 0.62,
          L / 2 + 0.05,
          true,
          0.092,
          runnerMat,
          0.36,
        ),
      );

      // padded headboard in front of the flat GLB panel
      bed.add(
        makeHeadboard(
          W,
          -0.25,
          0.8,
          -L / 2 + 0.006,
          fabricMat("headboard2", "#8f8878", "60,55,45", 1),
        ),
      );
      dressBedside(r);

      // pillows against the headboard
      [-1, 1].forEach((s) => {
        const p = makePillow(0.4, 0.27, 0.14, white);
        p.position.set(s * (W * 0.24), 0.07, -L / 2 + 0.3);
        p.rotation.x = -0.14;
        p.rotation.y = s * 0.04;
        bed.add(p);

        const q = makePillow(0.32, 0.21, 0.11, white);
        q.position.set(s * (W * 0.24) + s * 0.02, 0.15, -L / 2 + 0.2);
        q.rotation.x = -0.35;
        bed.add(q);
      });
      // olive cushions on top
      [-1, 1].forEach((s) => {
        const c = makePillow(0.2, 0.2, 0.1, oliveMat);
        c.position.set(s * 0.24, 0.17, -L / 2 + 0.58);
        c.rotation.x = -0.45;
        c.rotation.y = s * 0.5;
        bed.add(c);
      });

      // grey carpet under the bed and the seating area
      const rugMat = fabricMat("carpet", "#9a958c", "60,58,52", 1);
      rugMat.map.repeat.set(1, 1);
      rugMat.polygonOffset = true;
      rugMat.polygonOffsetFactor = -2;
      rugMat.polygonOffsetUnits = -2;
      const rugW = W + 1.7;
      const rugL = L + 1.5;
      const rugGeo = new THREE.PlaneGeometry(rugW, rugL);
      const uvAttr = rugGeo.attributes.uv;
      for (let i = 0; i < uvAttr.count; i++) {
        uvAttr.setXY(
          i,
          uvAttr.getX(i) * rugW * 2.2,
          uvAttr.getY(i) * rugL * 2.2,
        );
      }
      const rug = new THREE.Mesh(rugGeo, rugMat);
      rug.raycast = () => {};
      rug.rotation.x = -Math.PI / 2;
      const rugGroup = new THREE.Group();
      rugGroup.position.set(
        r.center.x + foot.x * 0.35,
        r.floorY + 0.008,
        r.center.z + foot.z * 0.35,
      );
      rugGroup.rotation.y = yaw;
      rugGroup.add(rug);
      fx.group.add(rugGroup);
    };

    const getSkyTexture = () => {
      if (fx.skyTex) return fx.skyTex;
      const c = document.createElement("canvas");
      c.width = 4;
      c.height = 256;
      const g = c.getContext("2d");
      const grad = g.createLinearGradient(0, 0, 0, 256);
      grad.addColorStop(0, "#3f86d6");
      grad.addColorStop(0.55, "#8fc1ee");
      grad.addColorStop(1, "#dcecf8");
      g.fillStyle = grad;
      g.fillRect(0, 0, 4, 256);
      fx.skyTex = new THREE.CanvasTexture(c);
      fx.skyTex.colorSpace = THREE.SRGBColorSpace;
      return fx.skyTex;
    };

    // Curtains: sheer voile (always there) + heavy drapes that slide open / closed
    const makeCurtainFx = (r, w) => {
      const size = w.box.getSize(new THREE.Vector3());
      const c = w.box.getCenter(new THREE.Vector3());
      const alongX = size.x > size.z;
      const f = alongX
        ? new THREE.Vector3(0, 0, 1)
        : new THREE.Vector3(1, 0, 0);
      const toRoom = new THREE.Vector3(r.center.x - c.x, 0, r.center.z - c.z);
      if (f.dot(toRoom) < 0) f.negate();

      const half = (alongX ? size.z : size.x) / 2;
      const width = alongX ? size.x : size.z;
      const bottom = r.floorY + 0.06;
      const top = Math.min(w.box.max.y + 0.3, r.floorY + 2.75);
      const H = Math.max(top - bottom, 1);
      const W = width + 0.5;
      const pw = (W / 2) * 1.04;

      const group = new THREE.Group();
      group.visible = false;
      group.position.set(
        c.x + f.x * (half + 0.22),
        bottom,
        c.z + f.z * (half + 0.22),
      );
      group.rotation.y = Math.atan2(f.x, f.z);
      fx.group.add(group);

      // rod with finials
      const rodMat = new THREE.MeshStandardMaterial({
        color: 0x3a342d,
        roughness: 0.5,
        metalness: 0.6,
      });
      const rod = new THREE.Mesh(
        new THREE.CylinderGeometry(0.015, 0.015, W + 0.2, 10),
        rodMat,
      );
      rod.rotation.z = Math.PI / 2;
      rod.position.set(0, H + 0.02, 0);
      rod.raycast = () => {};
      group.add(rod);
      [-1, 1].forEach((s) => {
        const ball = new THREE.Mesh(
          new THREE.SphereGeometry(0.03, 12, 10),
          rodMat,
        );
        ball.position.set((s * (W + 0.2)) / 2, H + 0.02, 0);
        ball.raycast = () => {};
        group.add(ball);
      });

      // sheer voile just behind the drapes (stays when the drapes are open)
      const sheerGeo = new THREE.PlaneGeometry(W, H, 48, 1);
      sheerGeo.translate(0, H / 2, 0);
      const sheerArr = sheerGeo.attributes.position.array;
      for (let i = 0; i < sheerArr.length; i += 3) {
        sheerArr[i + 2] = -0.07 + Math.sin(sheerArr[i] * 14) * 0.018;
      }
      sheerGeo.computeVertexNormals();
      const sheer = new THREE.Mesh(
        sheerGeo,
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.38,
          roughness: 1,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      sheer.raycast = () => {};
      group.add(sheer);

      const item = {
        type: "curtains",
        room: r.index,
        group,
        level: demoDeviceRef.current.curtains === false ? 1 : 0,
        led: null,
        tick: null,
        center: new THREE.Vector3(c.x, bottom + H / 2, c.z),
        front: f.clone(),
      };

      const panels = [-1, 1].map((dir) => {
        const geo = new THREE.PlaneGeometry(pw, H, 64, 8);
        geo.translate((dir * -1 * pw) / 2, H / 2, 0);
        const base = geo.attributes.position.array.slice();
        const mesh = new THREE.Mesh(
          geo,
          fabricMat("curtain", "#e4d9c6", "90,75,55", 2, 0xf0e6d4),
        );
        mesh.position.x = dir * (W / 2);
        mesh.userData.isCurtain = item;
        group.add(mesh);
        return { mesh, base };
      });

      let lastKey = "";
      item.tick = (level, t, dt, target) => {
        const s = level * level * (3 - 2 * level);
        const moving = Math.abs(target - level) > 0.003;
        const scaleX = 0.16 + 0.84 * s;
        const key = moving ? "m" : "s";
        panels.forEach(({ mesh, base }) => {
          mesh.scale.x = scaleX;
          if (!moving && lastKey === "s") return;
          const arr = mesh.geometry.attributes.position.array;
          for (let i = 0; i < arr.length; i += 3) {
            const x = base[i];
            const yN = base[i + 1] / H; // 0 bottom .. 1 top
            const folds = Math.sin(x * 12.5) + 0.35 * Math.sin(x * 28 + 1.3);
            const sway = moving ? Math.sin(t * 4 + x * 3) * 0.03 * (1 - yN) : 0;
            arr[i + 2] = folds * 0.065 * (1 + 0.4 * (1 - yN)) + sway;
          }
          mesh.geometry.attributes.position.needsUpdate = true;
          mesh.geometry.computeVertexNormals();
        });
        lastKey = key;
      };

      return item;
    };

    const buildRoomFx = (index) => {
      fx.built.add(index);
      const r = rooms[index];
      if (!r) return;
      buildBedding(r);

      ["microwave", "tv", "ac", "fridge"].forEach((type) => {
        const rep = r.rep[type];
        if (rep) fx.items.push(makeDeviceFx(type, rep.device, index));
      });
      fx.items.push(makeLightFx(r));

      // windows that belong to this room (nearest bed), biggest first
      windowsList
        .filter((w) => {
          const wc = w.box.getCenter(new THREE.Vector3());
          const sz = w.box.getSize(new THREE.Vector3());
          if (Math.abs(wc.y - r.floorY) > 3.5) return false;
          if (w.box.min.y > r.floorY + 1.6) return false;
          if (Math.max(sz.x, sz.z) < 0.5 || sz.y < 0.6) return false;
          if (Math.min(sz.x, sz.z) > 0.5) return false;
          let best = null;
          rooms.forEach((o) => {
            const d = Math.hypot(wc.x - o.center.x, wc.z - o.center.z);
            if (d < 9.5 && (!best || d < best.d)) best = { d, index: o.index };
          });
          return best && best.index === index;
        })
        .sort(
          (a, b) =>
            b.box.getSize(new THREE.Vector3()).y *
              Math.max(
                b.box.getSize(new THREE.Vector3()).x,
                b.box.getSize(new THREE.Vector3()).z,
              ) -
            a.box.getSize(new THREE.Vector3()).y *
              Math.max(
                a.box.getSize(new THREE.Vector3()).x,
                a.box.getSize(new THREE.Vector3()).z,
              ),
        )
        .slice(0, 3)
        .forEach((w) => fx.items.push(makeCurtainFx(r, w)));
    };

    const disposeEffects = () => {
      fx.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      fx.group.clear();
      fx.lamps = [];
      fx.items = [];
      fx.built.clear();
    };

    const updateEffects = (now, dt) => {
      // real sky behind the windows while you are inside a room
      if (fx.skyOn !== walk.active) {
        fx.skyOn = walk.active;
        scene.background = walk.active ? getSkyTexture() : fx.plainBg;
      }

      const demo = demoDeviceRef.current || {};
      const power = demo.power !== false;

      // bedside lamps follow the room lights
      const lampOn = power && demo.light !== false;
      const lampEase = Math.min(1, dt * 7);
      fx.lamps.forEach((l) => {
        l.level += ((lampOn ? 1 : 0) - l.level) * lampEase;
        l.shade.material.emissiveIntensity = 0.12 + 0.85 * l.level;
        const near = THREE.MathUtils.clamp(
          (l.halo.position.distanceTo(camera.position) - 0.4) / 1.0,
          0,
          1,
        );
        l.halo.material.opacity = l.level * 0.35 * near;
      });

      const room =
        walk.active && currentRoom.floorIdx === 0 && currentRoom.index >= 0
          ? currentRoom.index
          : -1;

      if (room >= 0 && !fx.built.has(room)) buildRoomFx(room);
      if (!fx.items.length) return;

      const t = now / 1000;
      const ease = Math.min(1, dt * 7);
      let tvOn = false;

      fx.items.forEach((item) => {
        const here = item.room === room;
        item.group.visible = here;
        if (!here) {
          if (item.type !== "curtains") item.level = 0;
          return;
        }

        if (item.type === "curtains") {
          // 0 = open, 1 = closed; slides over ~1.6 s
          const target = demo.curtains === false ? 1 : 0;
          const step = dt / 1.6;
          item.level += Math.max(-step, Math.min(step, target - item.level));
          item.tick(item.level, t, dt, target);
          return;
        }

        const on = power && !!demo[item.type];
        item.level += ((on ? 1 : 0) - item.level) * ease;
        if (item.led)
          item.led.material.color.setHex(on ? FX_LED_ON : FX_LED_OFF);
        if (item.tick) item.tick(item.level, t, dt);
        if (item.type === "tv" && item.level > 0.01) tvOn = true;
      });

      if (tvOn && now - fx.tvLast > 80) {
        fx.tvLast = now;
        drawTv(t);
      }
    };

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
      for (const type of SWITCHABLE) {
        data[type] = demo.power && demo[type] ? "ON" : "OFF";
      }
      data.acTemp = roomTempRef.current;
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

      const intersects = raycaster.intersectObjects(
        [modelGroup, fx.group],
        true,
      );

      // first device hit, unless a wall is in front of it
      let device = null;
      for (const hit of intersects) {
        const curtainFx = hit.object.userData.isCurtain;
        if (curtainFx && curtainFx.group.visible && walk.active) {
          changeRoomControl("curtains");
          setSelectedName("Curtains");
          setControlMessage(
            `Curtains ${demoDeviceRef.current.curtains ? "Open" : "Closed"}`,
          );
          return;
        }
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
        walk.active &&
        (device.center.distanceTo(camera.position) < 3.5 ||
          (device.room >= 0 && device.room === currentRoom.index));

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
      for (const type of SWITCHABLE) {
        data[type] = demo.power && demo[type] ? "ON" : "OFF";
      }
      data.acTemp = roomTempRef.current;
      const key = JSON.stringify([
        data.light,
        data.ac,
        data.acTemp,
        data.fridge,
        data.microwave,
        data.tv,
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

      updateEffects(performance.now(), delta);
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

      disposeEffects();
      if (fx.glowTex) fx.glowTex.dispose();
      if (fx.skyTex) fx.skyTex.dispose();
      Object.values(fx.fabric).forEach((tex) => tex.dispose());
      if (fx.tvTex) fx.tvTex.dispose();
      scene.remove(fx.group);

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
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                {key === "curtains"
                  ? `Curtains (${roomControls.curtains ? "Open" : "Closed"})`
                  : label}
              </span>
              <button
                type="button"
                onClick={() => {
                  changeRoomControl(key);
                  // walk up to the device so you can see it switch
                  if (SWITCHABLE.includes(key) || key === "curtains")
                    apiRef.current?.goToType(key);
                }}
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
                {key === "curtains"
                  ? roomControls[key]
                    ? "OPEN"
                    : "CLOSED"
                  : roomControls[key]
                    ? "ON"
                    : "OFF"}
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
            onChange={(e) => {
              const temp = Number(e.target.value);
              roomTempRef.current = temp;
              setRoomTemp(temp);
              if (SEND_TO_HARDWARE) controlACTemp(temp);
            }}
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
