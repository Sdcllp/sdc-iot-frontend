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

const DEVICE_NAME_HINTS = {
  ac: ["ac", "airconditioner", "air_conditioner", "acunit", "ac_unit", "hvac"],
  light: ["light", "ceilinglight", "ceiling_light", "downlight", "lamp"],
  temperature: ["temperature", "temp", "dht", "tempsensor", "temp_sensor"],
  humidity: ["humidity", "humid", "humidsensor", "humidity_sensor"],
  motion: ["motion", "motionsensor", "motion_sensor", "pir"],
  sensor: ["sensor", "irsensor", "ir_sensor", "ir"],
  touch: ["touch", "touchsensor", "touch_sensor"],
  rfid: ["rfid", "rfidsensor", "rfid_sensor"],
  ldr: ["ldr", "ldrsensor", "ldr_sensor", "lightdependentresistor"],
};

const MANUAL_DEVICE_MESH_NAMES = {
  ac: ["mesh 57", "mesh_57", "Mesh 57", "AC"],
  temperature: ["mesh 58", "mesh_58", "Mesh 58", "Object mesh 58", "Object mesh 58 1"],
  humidity: ["mesh 30 1", "mesh_30_1", "Mesh 30 1", "Object mesh 30 1"],
  light: ["mesh 45 1", "mesh_45_1", "Mesh 45 1", "Object mesh 45 1"],
  ldr: ["mesh 6", "mesh_6", "Mesh 6", "Object mesh 6"],

  // ✅ Motion Sensor - your selected object
  motion: ["mesh 54", "mesh_54", "Mesh 54", "Object mesh 54"],
};

const cleanName = (name = "") => {
  const value = String(name || "")
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .replace(/\./g, " ")
    .trim();

  return value || "Object";
};

export default function Viewer() {
  const mountRef = useRef(null);

  const [selectedName, setSelectedName] = useState("None");
  const [selectedControl, setSelectedControl] = useState("");
  const [loadedFile, setLoadedFile] = useState("");
  const [loadError, setLoadError] = useState("");
  const [sending, setSending] = useState(false);
  const [controlMessage, setControlMessage] = useState("");

  const [deviceData, setDeviceData] = useState({
    temperature: "--",
    humidity: "--",
    motion: "--",
    distance: "--",
    ldr: "--",
    ir: "--",
    touch: "--",
    rfid: "--",
    light: "OFF",
    ac: "OFF",
    acTemp: 24,
    updatedAt: null,
  });

  const meshMapRef = useRef({});
  const lastHighlightedRef = useRef(null);
  const transparentObjectsRef = useRef([]);
  const popupRef = useRef(null);
  const selectedObjectRef = useRef(null);
  const latestDeviceDataRef = useRef(deviceData);
  const flyToMeshRef = useRef(null);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

  const getErrorMessage = (error, fallback) => {
    console.error(fallback, error.response?.data || error.message);
    return error.response?.data?.message || error.response?.data?.error || error.message || fallback;
  };

  const controlLight = async (state) => {
    try {
      setSending(true);
      setControlMessage("");
      const res = await axios.post(`${API_BASE_URL}/devices/light`, { state });

      if (res.data?.success) {
        setDeviceData((prev) => ({ ...prev, ...res.data.data }));
        setControlMessage(res.data.message || `Light ${state}`);
      } else {
        setControlMessage(res.data?.message || "Light control failed");
      }
    } catch (error) {
      setControlMessage(getErrorMessage(error, "Failed to control light"));
    } finally {
      setSending(false);
    }
  };

  const controlAC = async (state) => {
    try {
      setSending(true);
      setControlMessage("");
      const res = await axios.post(`${API_BASE_URL}/devices/ac`, { state });

      if (res.data?.success) {
        setDeviceData((prev) => ({ ...prev, ...res.data.data }));
        setControlMessage(res.data.message || `AC ${state}`);
      } else {
        setControlMessage(res.data?.message || "AC control failed");
      }
    } catch (error) {
      setControlMessage(getErrorMessage(error, "Failed to control AC"));
    } finally {
      setSending(false);
    }
  };

  const controlACTemp = async (temp) => {
    try {
      setSending(true);
      setControlMessage("");
      const res = await axios.post(`${API_BASE_URL}/devices/ac-temp`, { temp });

      if (res.data?.success) {
        setDeviceData((prev) => ({ ...prev, ...res.data.data }));
        setControlMessage(res.data.message || `AC temp set to ${temp}°C`);
      } else {
        setControlMessage(res.data?.message || "AC temperature failed");
      }
    } catch (error) {
      setControlMessage(getErrorMessage(error, "Failed to set AC temperature"));
    } finally {
      setSending(false);
    }
  };

  const detectDeviceType = (name = "", mesh = null) => {
    const cleaned = cleanName(name);
    const raw = cleaned.toLowerCase().replace(/\s+/g, "");

    if (mesh && meshMapRef.current.ac === mesh) return "ac";
    if (mesh && meshMapRef.current.temperature === mesh) return "temperature";
    if (mesh && meshMapRef.current.humidity === mesh) return "humidity";
    if (mesh && meshMapRef.current.light === mesh) return "light";
    if (mesh && meshMapRef.current.ldr === mesh) return "ldr";
    if (mesh && meshMapRef.current.motion === mesh) return "motion";
    if (mesh && meshMapRef.current.sensor === mesh) return "sensor";
    if (mesh && meshMapRef.current.touch === mesh) return "touch";
    if (mesh && meshMapRef.current.rfid === mesh) return "rfid";

    for (const [type, names] of Object.entries(MANUAL_DEVICE_MESH_NAMES)) {
      if (names.some((item) => item.toLowerCase() === cleaned.toLowerCase())) {
        return type;
      }
    }

    for (const [type, hints] of Object.entries(DEVICE_NAME_HINTS)) {
      if (hints.some((hint) => raw.includes(hint.replace(/\s+/g, "")))) {
        return type;
      }
    }

    return "";
  };

  const goToDevice = (type) => {
    const mesh = meshMapRef.current[type];

    if (!mesh) {
      setControlMessage(`${type.toUpperCase()} object not found in model`);
      return;
    }

    selectedObjectRef.current = mesh;
    setSelectedControl(type);
    flyToMeshRef.current?.(mesh, type.toUpperCase());
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf5f5f5);

    const camera = new THREE.PerspectiveCamera(60, mount.clientWidth / mount.clientHeight, 0.1, 5000);
    camera.position.set(0, 18, 45);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const popup = document.createElement("div");
    popup.className = "model-popup";
    popup.style.display = "none";
    mount.appendChild(popup);
    popupRef.current = popup;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.enableRotate = true;
    controls.minDistance = 1;
    controls.maxDistance = 500;
controls.enableDamping = true;
controls.enableRotate = true;
controls.enableZoom = true;
controls.enablePan = true;

controls.rotateSpeed = 0.8;
controls.zoomSpeed = 1.2;
controls.panSpeed = 0.8;

controls.minDistance = 0.001;
controls.maxDistance = 500;

controls.enablePan = true;
controls.enableZoom = true;
controls.enableRotate = true;

controls.target.set(0,0,0);
controls.maxDistance = 100;
    scene.add(new THREE.AmbientLight(0xffffff, 1.8));

    const directionalLight1 = new THREE.DirectionalLight(0xffffff, 1.2);
    directionalLight1.position.set(50, 60, 40);
    scene.add(directionalLight1);

    const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight2.position.set(-40, 30, -30);
    scene.add(directionalLight2);

    const gridHelper = new THREE.GridHelper(200, 50);
    scene.add(gridHelper);

    const modelGroup = new THREE.Group();
    scene.add(modelGroup);

    const pivot = new THREE.Group();
    modelGroup.add(pivot);

    const loader = new GLTFLoader();
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    let animationId = null;
let isInsideMode = false;
let insideBox = null;
    const isRedMesh = (mesh) => {
      if (!mesh?.material) return false;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

      return materials.some((mat) => {
        if (!mat.color) return false;
        return mat.color.r > 0.7 && mat.color.g < 0.35 && mat.color.b < 0.35;
      });
    };

    const normalizeMeshMaterial = (mesh) => {
      if (!mesh.isMesh || !mesh.material) return;

      const oldMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

      const newMaterials = oldMaterials.map((mat) => {
        const newMat = new THREE.MeshStandardMaterial({
          color: mat?.color ? mat.color.clone() : new THREE.Color(0xb0b0b0),
          roughness: 0.85,
          metalness: 0.1,
        });

        newMat.userData.originalColor = newMat.color.clone();
        return newMat;
      });

      mesh.material = Array.isArray(mesh.material) ? newMaterials : newMaterials[0];
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    };

    const clearHighlight = () => {
      const last = lastHighlightedRef.current;
      if (!last?.material) return;

      const materials = Array.isArray(last.material) ? last.material : [last.material];

      materials.forEach((mat) => {
        if (mat.userData?.originalColor) {
          mat.color.copy(mat.userData.originalColor);
        }

        if ("emissive" in mat) {
          mat.emissive.setHex(0x000000);
          mat.emissiveIntensity = 1;
        }
      });

      lastHighlightedRef.current = null;
    };

    const highlightMesh = (mesh) => {
      clearHighlight();
      if (!mesh?.material) return;

      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

      materials.forEach((mat) => {
        if ("color" in mat) mat.color.setHex(0xffc107);
        if ("emissive" in mat) {
          mat.emissive.setHex(0xffc107);
          mat.emissiveIntensity = 1.4;
        }
      });

      lastHighlightedRef.current = mesh;
    };
const restoreTransparency = () => {
  transparentObjectsRef.current.forEach(({ mesh, original }) => {
    if (!mesh) return;

    mesh.visible = original.visible;

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

    materials.forEach((mat, index) => {
      const item = original.materials?.[index];
      if (!item) return;

      mat.transparent = item.transparent;
      mat.opacity = item.opacity;
      mat.depthWrite = item.depthWrite;
      mat.side = item.side;
    });
  });

  transparentObjectsRef.current = [];
};
    const makeWallTransparent = () => {
      restoreTransparency();

      modelGroup.traverse((child) => {
        if (!child.isMesh || !child.material) return;

        const name = cleanName(child.name).toLowerCase();
        const box = new THREE.Box3().setFromObject(child);
        const size = box.getSize(new THREE.Vector3());

        const isWallLike =
          name.includes("wall") ||
          name.includes("panel") ||
          name.includes("front") ||
          size.x > size.z * 2.5 ||
          size.z > size.x * 2.5;

        if (!isWallLike) return;

        const materials = Array.isArray(child.material) ? child.material : [child.material];

   const original = {
  visible: child.visible,
  materials: materials.map((mat) => ({
    transparent: mat.transparent,
    opacity: mat.opacity,
    depthWrite: mat.depthWrite,
    side: mat.side,
  })),
};

        materials.forEach((mat) => {
          mat.transparent = true;
     mat.opacity = 0.03;
       mat.depthWrite = false;
          mat.polygonOffset = true;
          mat.polygonOffsetFactor = 1;
          mat.polygonOffsetUnits = 1;
        });

        transparentObjectsRef.current.push({ mesh: child, original });
      });
    };
const fitCameraToObject = () => {
  isInsideMode = false;
  insideBox = null;

  restoreTransparency();
  gridHelper.visible = true;
  restoreTransparency();
  gridHelper.visible = true;

  controls.enablePan = true;
  controls.enableZoom = true;
  controls.enableRotate = true;
  controls.minDistance = 5;
  controls.maxDistance = 500;

  const box = new THREE.Box3().setFromObject(modelGroup);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z) || 20;
  const distance = maxDim * 1.45;

  // ✅ Front View from X side
  controls.target.set(
    box.max.x,
    center.y + size.y * 0.32,
    center.z
  );

  camera.position.set(
    box.max.x + distance,
    center.y + size.y * 0.36,
    center.z
  );

  camera.fov = 45;
  camera.near = 0.1;
  camera.far = 5000;
  camera.updateProjectionMatrix();

  camera.lookAt(controls.target);
  controls.update();

  if (popupRef.current) popupRef.current.style.display = "none";
  selectedObjectRef.current = null;
};
const insideView = () => {
  restoreTransparency();
  gridHelper.visible = false;

  const box = new THREE.Box3().setFromObject(modelGroup);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  isInsideMode = true;
  insideBox = box.clone();

  // Room ke andar wall visible rahe
  modelGroup.traverse((child) => {
    if (!child.isMesh || !child.material) return;

    const materials = Array.isArray(child.material) ? child.material : [child.material];

    materials.forEach((mat) => {
      mat.side = THREE.DoubleSide;
      mat.transparent = false;
      mat.opacity = 1;
      mat.depthWrite = true;
    });
  });

  const eyeHeight = center.y + size.y * 0.18;

  camera.position.set(
    center.x,
    eyeHeight,
    center.z + size.z * 0.15
  );

  controls.target.set(
    center.x,
    eyeHeight,
    center.z - 0.01
  );

  camera.fov = 80;
  camera.near = 0.01;
  camera.far = 5000;
  camera.updateProjectionMatrix();

  // Important: room se bahar na jaye
  controls.enableRotate = true;
controls.enableZoom = false; // Orbit zoom off rakho
  controls.enablePan = false;

  controls.minDistance = 0.01;
  controls.maxDistance = 0.01;

  controls.rotateSpeed = 0.6;

  controls.update();

  selectedObjectRef.current = null;
  if (popupRef.current) popupRef.current.style.display = "none";
};
  const moveCameraToMesh = (mesh) => {
  if (!mesh) return;

  restoreTransparency();
  gridHelper.visible = false;

  const type = detectDeviceType(mesh.name, mesh);

  const roomBox = new THREE.Box3().setFromObject(modelGroup);
  const roomSize = roomBox.getSize(new THREE.Vector3());

  const box = new THREE.Box3().setFromObject(mesh);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  // ✅ Light special camera: room + light dono dikhne ke liye
  if (type === "light") {
    const viewDistance = Math.max(7, roomSize.z * 0.45);

    camera.position.set(
      center.x + 5,
      center.y - 3.5,
      center.z + viewDistance
    );

    controls.target.set(
      center.x,
      center.y - 0.35,
      center.z
    );

    camera.fov = 72;
    camera.near = 0.01;
    camera.far = 5000;
    camera.updateProjectionMatrix();

    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.enablePan = true;
    controls.minDistance = 1;
    controls.maxDistance = 90;

    camera.lookAt(controls.target);
    controls.update();
    return;
  }
// ✅ Motion special camera: sensor clearly visible
if (type === "motion") {
  const viewDistance = Math.max(6, roomSize.z * 0.35);

  camera.position.set(
    center.x + 4,
    center.y - 3.2,
    center.z + viewDistance
  );

  controls.target.set(
    center.x,
    center.y - 0.25,
    center.z
  );

  camera.fov = 70;
  camera.near = 0.01;
  camera.far = 5000;
  camera.updateProjectionMatrix();

  controls.enableRotate = true;
  controls.enableZoom = true;
  controls.enablePan = true;
  controls.minDistance = 1;
  controls.maxDistance = 80;

  camera.lookAt(controls.target);
  controls.update();
  return;
}
  const maxMeshSize = Math.max(size.x, size.y, size.z) || 1;
  const distance = Math.max(8, maxMeshSize * 18);
  const eyeHeight = center.y + Math.max(1.2, size.y * 2);

  camera.position.set(
    center.x + distance,
    eyeHeight,
    center.z + distance * 0.7
  );

  controls.target.set(
    center.x,
    center.y + size.y * 0.4,
    center.z
  );

  camera.fov = 45;
  camera.near = 0.01;
  camera.far = 5000;
  camera.updateProjectionMatrix();

  controls.enableRotate = true;
  controls.enableZoom = true;
  controls.enablePan = true;
  controls.minDistance = 2;
  controls.maxDistance = Math.max(30, roomSize.length());

  camera.lookAt(controls.target);
  controls.update();
};

    flyToMeshRef.current = (mesh, label = "") => {
      selectedObjectRef.current = mesh;

      const type = detectDeviceType(label || mesh?.name, mesh);

      const finalLabel =
        type === "temperature"
          ? "Temperature"
          : type === "humidity"
          ? "Humidity"
          : type === "motion"
          ? "Motion"
          : type === "light"
          ? "Light"
          : type === "ldr"
          ? "LDR"
          : type === "ac"
          ? "AC"
          : label || cleanName(mesh?.name);

      setSelectedName(finalLabel);
      setSelectedControl(type);

      highlightMesh(mesh);
      moveCameraToMesh(mesh);
    };

    const centerAndGroundModel = () => {
      const box = new THREE.Box3().setFromObject(modelGroup);
      const center = box.getCenter(new THREE.Vector3());

      modelGroup.position.x -= center.x;
      modelGroup.position.y -= center.y;
      modelGroup.position.z -= center.z;

      const box2 = new THREE.Box3().setFromObject(modelGroup);
      const size2 = box2.getSize(new THREE.Vector3());
      const maxDim = Math.max(size2.x, size2.y, size2.z);
      const scale = maxDim > 0 ? 30 / maxDim : 1;

      modelGroup.scale.setScalar(scale);

      const box3 = new THREE.Box3().setFromObject(modelGroup);
      modelGroup.position.y -= box3.min.y;
    };

    const buildDeviceMap = (root) => {
      meshMapRef.current = {};

      const candidates = {
        ac: [],
        temperature: [],
        humidity: [],
        motion: [],
        light: [],
        ldr: [],
        sensor: [],
        touch: [],
        rfid: [],
      };

      root.traverse((child) => {
        if (!child.isMesh) return;

        const originalName = cleanName(child.name);

        const manualAC = MANUAL_DEVICE_MESH_NAMES.ac.some(
          (item) => item.toLowerCase() === originalName.toLowerCase()
        );

        const manualTemperature = MANUAL_DEVICE_MESH_NAMES.temperature.some(
          (item) => item.toLowerCase() === originalName.toLowerCase()
        );

        const manualHumidity = MANUAL_DEVICE_MESH_NAMES.humidity.some(
          (item) => item.toLowerCase() === originalName.toLowerCase()
        );

        const manualMotion = MANUAL_DEVICE_MESH_NAMES.motion.some(
          (item) => item.toLowerCase() === originalName.toLowerCase()
        );

        const manualLight = MANUAL_DEVICE_MESH_NAMES.light.some(
          (item) => item.toLowerCase() === originalName.toLowerCase()
        );

        const manualLDR = MANUAL_DEVICE_MESH_NAMES.ldr.some(
          (item) => item.toLowerCase() === originalName.toLowerCase()
        );

        const redBeforeNormalize = isRedMesh(child);
        normalizeMeshMaterial(child);

        if (manualAC || redBeforeNormalize) {
          child.name = "AC";
          meshMapRef.current.ac = child;
          return;
        }

        if (manualTemperature) {
          child.name = "Temperature Sensor";
          meshMapRef.current.temperature = child;
          return;
        }

        if (manualHumidity) {
          child.name = "Humidity";
          meshMapRef.current.humidity = child;
          return;
        }

        if (manualMotion) {
          child.name = "Motion Sensor";
          meshMapRef.current.motion = child;
          return;
        }

        if (manualLight) {
          child.name = "Light";
          meshMapRef.current.light = child;
          return;
        }

        if (manualLDR) {
          child.name = "LDR";
          meshMapRef.current.ldr = child;
          return;
        }

        const lower = originalName.toLowerCase().replace(/\s+/g, "");

        Object.entries(DEVICE_NAME_HINTS).forEach(([type, hints]) => {
          let score = 0;

          hints.forEach((hint, index) => {
            const cleanHint = hint.toLowerCase().replace(/\s+/g, "");
            if (lower === cleanHint) score += 100 - index;
            else if (lower.includes(cleanHint)) score += 50 - index;
          });

          if (score > 0) {
            candidates[type].push({ mesh: child, score });
          }
        });
      });

      Object.keys(candidates).forEach((type) => {
        if (!meshMapRef.current[type] && candidates[type].length) {
          meshMapRef.current[type] = candidates[type].sort((a, b) => b.score - a.score)[0].mesh;
        }
      });

      console.log("Device mesh map:", {
        ac: meshMapRef.current.ac?.name,
        temperature: meshMapRef.current.temperature?.name,
        humidity: meshMapRef.current.humidity?.name,
        motion: meshMapRef.current.motion?.name,
        light: meshMapRef.current.light?.name,
        ldr: meshMapRef.current.ldr?.name,
      });
    };

    const updatePopup = () => {
      const popupEl = popupRef.current;
      const selected = selectedObjectRef.current;

      if (!popupEl || !selected) {
        if (popupEl) popupEl.style.display = "none";
        return;
      }

      const box = new THREE.Box3().setFromObject(selected);
      const center = box.getCenter(new THREE.Vector3());

      center.y += 1.3;
      center.project(camera);

      const x = (center.x * 0.5 + 0.5) * mount.clientWidth;
      const y = (-center.y * 0.5 + 0.5) * mount.clientHeight;

      const type = detectDeviceType(selected.name, selected);
      const data = latestDeviceDataRef.current;

      if (type === "motion") {
        popupEl.innerHTML = `
          <div style="font-weight:700;">Motion Sensor</div>
          <div>Status: ${data.motion || "--"}</div>
          <div style="font-size:11px; margin-top:4px;">Object mesh 54</div>
        `;
        popupEl.style.background =
          String(data.motion).toUpperCase() === "DETECTED" || String(data.motion).toUpperCase() === "ON"
            ? "#dcfce7"
            : "#ffffff";
        popupEl.style.color =
          String(data.motion).toUpperCase() === "DETECTED" || String(data.motion).toUpperCase() === "ON"
            ? "#166534"
            : "#111827";
        popupEl.style.border = "1px solid #86efac";
      } else if (type === "ac") {
        popupEl.innerHTML = `
          <div style="font-weight:700;">AC</div>
          <div>Status: ${data.ac || "OFF"} | ${data.acTemp || 24}°C</div>
          <div style="font-size:11px; margin-top:4px;">Click AC object to toggle</div>
        `;
        popupEl.style.background = data.ac === "ON" ? "#dcfce7" : "#fee2e2";
        popupEl.style.color = data.ac === "ON" ? "#166534" : "#991b1b";
        popupEl.style.border = data.ac === "ON" ? "1px solid #86efac" : "1px solid #fecaca";
      } else if (type === "temperature") {
        popupEl.innerHTML = `
          <div style="font-weight:700;">Temperature</div>
          <div>${data.temperature || "--"} °C</div>
        `;
        popupEl.style.background = "#e0f2fe";
        popupEl.style.color = "#075985";
        popupEl.style.border = "1px solid #7dd3fc";
      } else if (type === "humidity") {
        popupEl.innerHTML = `
          <div style="font-weight:700;">Humidity</div>
          <div>${data.humidity || "--"} %</div>
        `;
        popupEl.style.background = "#dbeafe";
        popupEl.style.color = "#1e3a8a";
        popupEl.style.border = "1px solid #93c5fd";
      } else if (type === "light") {
        popupEl.innerHTML = `
          <div style="font-weight:700;">Light</div>
          <div>Status: ${data.light || "OFF"}</div>
          <div style="font-size:11px; margin-top:4px;">Click light object to toggle</div>
        `;
        popupEl.style.background = data.light === "ON" ? "#dcfce7" : "#fef3c7";
        popupEl.style.color = data.light === "ON" ? "#166534" : "#92400e";
        popupEl.style.border = data.light === "ON" ? "1px solid #86efac" : "1px solid #fde68a";
      } else if (type === "ldr") {
        popupEl.innerHTML = `
          <div style="font-weight:700;">LDR Sensor</div>
          <div>Value : ${data.ldr || "--"}</div>
        `;
        popupEl.style.background = "#e0f2fe";
        popupEl.style.color = "#075985";
        popupEl.style.border = "1px solid #7dd3fc";
      } else {
        popupEl.innerHTML = `Object<br/>${cleanName(selected.name)}`;
        popupEl.style.background = "#ffffff";
        popupEl.style.color = "#111827";
        popupEl.style.border = "1px solid #d1d5db";
      }

      popupEl.style.left = `${x}px`;
      popupEl.style.top = `${y}px`;
      popupEl.style.transform = "translate(-50%, -120%)";
      popupEl.style.display = "block";
    };

    const updateDeviceObjectColors = () => {
      const updateColor = (mesh, status) => {
        if (!mesh?.material) return;

        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

        materials.forEach((mat) => {
          mat.color.set(status === "ON" ? "#22c55e" : "#ff0000");
          mat.userData.originalColor = mat.color.clone();
        });
      };

      updateColor(meshMapRef.current.ac, latestDeviceDataRef.current.ac);
      updateColor(meshMapRef.current.light, latestDeviceDataRef.current.light);
    };

    const handleCanvasClick = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();

      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);

   const intersects = raycaster.intersectObject(modelGroup, true);

if (!intersects.length) return;

// Sirf registered IoT device meshes hi select honge
const allowedMeshes = Object.values(meshMapRef.current).filter(Boolean);

const clicked = intersects.find((hit) =>
  allowedMeshes.includes(hit.object)
);

if (!clicked) {
  // Agar wall, floor, chair ya koi aur mesh click hua to ignore
  return;
}

const clickedMesh = clicked.object;
      const type = detectDeviceType(clickedMesh.name, clickedMesh);

      selectedObjectRef.current = clickedMesh;

      if (type === "ac") {
        const nextState = latestDeviceDataRef.current.ac === "ON" ? "OFF" : "ON";
        controlAC(nextState);
        setSelectedName("AC");
        setSelectedControl("ac");
        highlightMesh(clickedMesh);
        return;
      }

      if (type === "light") {
        const nextState = latestDeviceDataRef.current.light === "ON" ? "OFF" : "ON";
        controlLight(nextState);
        setSelectedName("Light");
        setSelectedControl("light");
        highlightMesh(clickedMesh);
        moveCameraToMesh(clickedMesh);
        return;
      }



      if (type === "motion") {
        setSelectedName("Motion");
        setSelectedControl("motion");
        highlightMesh(clickedMesh);
        moveCameraToMesh(clickedMesh);
        return;
      }

  if (type === "temperature") {
  setSelectedName("Temperature");
  setSelectedControl("temperature");
  highlightMesh(clickedMesh);
  moveCameraToMesh(clickedMesh);
  return;
}

  if (type === "humidity") {
  setSelectedName("Humidity");
  setSelectedControl("humidity");
  highlightMesh(clickedMesh);
  moveCameraToMesh(clickedMesh);
  return;
}

 if (type === "ldr") {
  setSelectedName("LDR");
  setSelectedControl("ldr");
  highlightMesh(clickedMesh);
  moveCameraToMesh(clickedMesh);
  return;
}

      const label = type ? type.toUpperCase() : cleanName(clickedMesh.name);

      setSelectedName(label);
      setSelectedControl(type);
      highlightMesh(clickedMesh);
    };

    const loadModel = () => {
      const modelPath = `${process.env.PUBLIC_URL}/models/smartroomapp.gltf`;

      loader.load(
        modelPath,
        (gltf) => {
          const loadedRoot = gltf.scene;
          pivot.add(loadedRoot);

          centerAndGroundModel();
          buildDeviceMap(loadedRoot);
          fitCameraToObject();
          isInsideMode = false;
insideBox = null;
Object.values(meshMapRef.current).forEach((mesh) => {
  if (mesh) {
    mesh.userData.isDevice = true;
  }
});
          setLoadError("");
          setLoadedFile(modelPath);
        },
        undefined,
        (error) => {
          console.error("Failed to load GLTF:", error);
          setLoadError("GLTF file load failed. Put smartroomapp.gltf and linked files in public/models.");
        }
      );
    };

    loadModel();

    const createButton = (text, className, onClick) => {
      const button = document.createElement("button");
      button.innerText = text;
      button.className = `viewer-floating-btn ${className}`;
      button.onclick = onClick;
      mount.appendChild(button);
      return button;
    };

    const frontButton = createButton("Front View", "front-btn", () => {
      fitCameraToObject();
      clearHighlight();
      setSelectedName("None");
      setSelectedControl("");
    });

    const insideButton = createButton("Inside View", "inside-btn", () => {
      insideView();
    });

    const resetButton = createButton("Reset", "reset-btn", () => {
      fitCameraToObject();
      clearHighlight();
      setSelectedName("None");
      setSelectedControl("");
    });

    renderer.domElement.addEventListener("click", handleCanvasClick);

// 👇 YAHI ADD KARO
const handleInsideWheel = (event) => {
  if (!isInsideMode || !insideBox) return;

  event.preventDefault();

  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);

  direction.y = 0;
  direction.normalize();

  const speed = 0.8;

  const move =
    event.deltaY > 0 ? -speed : speed;

  camera.position.addScaledVector(direction, move);
  controls.target.addScaledVector(direction, move);

  camera.position.x = THREE.MathUtils.clamp(
    camera.position.x,
    insideBox.min.x + 0.5,
    insideBox.max.x - 0.5
  );

  camera.position.z = THREE.MathUtils.clamp(
    camera.position.z,
    insideBox.min.z + 0.5,
    insideBox.max.z - 0.5
  );

  controls.update();
};

renderer.domElement.addEventListener(
  "wheel",
  handleInsideWheel,
  { passive: false }
);
 const animate = () => {
  animationId = requestAnimationFrame(animate);

  controls.update();

  if (isInsideMode && insideBox) {
    camera.position.x = THREE.MathUtils.clamp(
      camera.position.x,
      insideBox.min.x + 1,
      insideBox.max.x - 1
    );

    camera.position.y = THREE.MathUtils.clamp(
      camera.position.y,
      insideBox.min.y + 1,
      insideBox.max.y - 1
    );

    camera.position.z = THREE.MathUtils.clamp(
      camera.position.z,
      insideBox.min.z + 1,
      insideBox.max.z - 1
    );
  }

  updateDeviceObjectColors();
  updatePopup();
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
      window.removeEventListener("resize", handleResize);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("click", handleCanvasClick);
renderer.domElement.removeEventListener(
  "wheel",
  handleInsideWheel
);
      if (animationId) cancelAnimationFrame(animationId);

      clearHighlight();
      restoreTransparency();
      gridHelper.visible = true;
      controls.dispose();
      renderer.dispose();

      [frontButton, insideButton, resetButton].forEach((button) => {
        if (button && mount.contains(button)) mount.removeChild(button);
      });

      if (popupRef.current && mount.contains(popupRef.current)) {
        mount.removeChild(popupRef.current);
      }

      if (mount.contains(renderer.domElement)) {
        mount.removeChild(renderer.domElement);
      }
    };

 // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);


const devices = [
  {
    id: "temperature",
    label: "Temperature",
    value: `${deviceData.temperature} °C`,
    type: "temperature",
  },
  {
    id: "humidity",
    label: "Humidity",
    value: `${deviceData.humidity} %`,
    type: "humidity",
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
];

  return (
    <div className="viewer-page">
      <div ref={mountRef} className="viewer-3d" />

      <aside className="viewer-panel">
        <div className="panel-header">
          <div>
            <h3>Smart Room Panel</h3>
            <p>Live IoT Control Dashboard</p>
          </div>
        </div>

        {loadedFile && <div className="info-box">3D model loaded</div>}
        {loadError && <div className="error-box">{loadError}</div>}

        <div className="selected-box">
          <span>Selected</span>
          <strong>{selectedName || "None"}</strong>
        </div>

        <div className="data-card">
          <h4>Real-Time Device Data</h4>

          <div className="device-grid">
            {devices.map((device) => (
              <button
                key={device.id}
                type="button"
                className={`device-box ${device.type ? "clickable" : ""}`}
                onClick={() => {
                  setSelectedName(device.label);
                  setSelectedControl(device.type);

                  if (device.type) {
                    goToDevice(device.type);
                  } else {
                    selectedObjectRef.current = null;
                    if (popupRef.current) popupRef.current.style.display = "none";
                  }
                }}
              >
                <span>{device.label}</span>
                <strong>{device.value}</strong>
              </button>
            ))}
          </div>

          <div className="last-update">
            Last Update:{" "}
            {deviceData.updatedAt ? new Date(deviceData.updatedAt).toLocaleTimeString() : "--"}
          </div>
        </div>

        {selectedControl === "temperature" && (
          <div className="control-card">
            <h4>Temperature Sensor</h4>
            <p>
              Current Temperature: <strong>{deviceData.temperature} °C</strong>
            </p>
          </div>
        )}

        {selectedControl === "humidity" && (
          <div className="control-card">
            <h4>Humidity Sensor</h4>
            <p>
              Current Humidity: <strong>{deviceData.humidity} %</strong>
            </p>
          </div>
        )}

        {selectedControl === "motion" && (
          <div className="control-card">
            <h4>Motion Sensor</h4>
            <p>
              Current Motion: <strong>{deviceData.motion}</strong>
            </p>
            <p>Object: mesh 54</p>
          </div>
        )}

        {selectedControl === "ldr" && (
          <div className="control-card">
            <h4>LDR Sensor</h4>
            <p>
              Current LDR Value: <strong>{deviceData.ldr}</strong>
            </p>
          </div>
        )}

        {selectedControl === "light" && (
          <div className="control-card light-card">
            <h4>Light Control</h4>
            <p>
              Current Status: <strong>{deviceData.light}</strong>
            </p>

            <div className="btn-row">
              <button
                onClick={() => {
                  goToDevice("light");
                  controlLight("ON");
                }}
                disabled={sending}
              >
                Light ON
              </button>

              <button
                onClick={() => {
                  goToDevice("light");
                  controlLight("OFF");
                }}
                disabled={sending}
              >
                Light OFF
              </button>
            </div>
          </div>
        )}

        {selectedControl === "ac" && (
          <div className="control-card ac-card">
            <h4>Mitsubishi AC Control</h4>
            <p>
              Current Status: <strong>{deviceData.ac}</strong>
            </p>
            <p>
              Current Temp: <strong>{deviceData.acTemp} °C</strong>
            </p>

            <div className="btn-row">
              <button
                onClick={() => {
                  goToDevice("ac");
                  controlAC("ON");
                }}
                disabled={sending}
              >
                AC ON
              </button>

              <button
                onClick={() => {
                  goToDevice("ac");
                  controlAC("OFF");
                }}
                disabled={sending}
              >
                AC OFF
              </button>
            </div>

            <div className="temp-row">
              {[18, 20, 22, 24, 26].map((temp) => (
                <button
                  key={temp}
                  onClick={() => {
                    goToDevice("ac");
                    controlACTemp(temp);
                  }}
                  disabled={sending}
                >
                  {temp}°C
                </button>
              ))}
            </div>
          </div>
        )}

        {controlMessage && <div className="success-box">{controlMessage}</div>}
      </aside>
    </div>
  );
}
