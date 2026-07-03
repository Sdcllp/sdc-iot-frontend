import React, { useEffect, useRef, useState } from "react";
import axios from "axios";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { io } from "socket.io-client";
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
  motion: ["motion", "motionsensor", "motion_sensor", "pir"],
  sensor: ["sensor", "irsensor", "ir_sensor", "ir"],
  touch: ["touch", "touchsensor", "touch_sensor"],
  rfid: ["rfid", "rfidsensor", "rfid_sensor"],
};

const MANUAL_DEVICE_MESH_NAMES = {
  ac: [
    "mesh 57",
    "mesh_57",
    "Mesh 57",
    "AC"
  ],

 panasonicAc: [
    "Object mesh 6 1",
    "mesh 6 1",
    "mesh_6_1",
    "Mesh 6 1",
    "Panasonic AC"
  ]
};

const buttonStyle = {
  padding: "10px 14px",
  border: "1px solid #d1d5db",
  borderRadius: "8px",
  background: "#ffffff",
  cursor: "pointer",
  fontWeight: 600,
};

const smallButtonStyle = {
  padding: "8px 12px",
  border: "1px solid #d1d5db",
  borderRadius: "8px",
  background: "#ffffff",
  cursor: "pointer",
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
    panasonicAc: "OFF",
panasonicAcTemp:24,
    updatedAt: null,
  });

  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const modelGroupRef = useRef(null);
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

  socket.on("connect", () => {
    console.log("✅ Socket connected:", SOCKET_URL);
  });

  socket.on("deviceData", (data) => {
    setDeviceData(data);
  });

  socket.on("connect_error", (error) => {
    console.error("❌ Socket error:", error.message);
  });

  socket.on("disconnect", () => {
    console.log("❌ Socket disconnected");
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
const controlLight = async (state) => {
  try {
    setSending(true);
    setControlMessage("");

    const res = await axios.post(`${API_BASE_URL}/devices/light`, { state });

    if (res.data?.success) {
      setDeviceData(res.data.data);
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
      setDeviceData(res.data.data);
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
const controlPanasonicAC = async (state) => {
  try {

    setSending(true);

    const res = await axios.post(
      `${API_BASE_URL}/devices/panasonic-ac`,
      { state }
    );

    if (res.data?.success) {

      setDeviceData(res.data.data);

      setControlMessage(
        res.data.message ||
        `Panasonic AC ${state}`
      );
    }

  } catch {

    setControlMessage(
      "Failed to control Panasonic AC"
    );

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
      setDeviceData(res.data.data);
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
    const raw = cleanName(name).toLowerCase().replace(/\s+/g, "");
if (mesh && meshMapRef.current.ac === mesh)
return "ac";

if (
mesh &&
meshMapRef.current.panasonicAc===mesh
)
return "panasonicAc";

if (mesh && meshMapRef.current.light === mesh)
return "light";

    if (MANUAL_DEVICE_MESH_NAMES.ac.some((item) => item.toLowerCase() === cleanName(name).toLowerCase())) {
      return "ac";
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
    setSelectedName(type.toUpperCase());
    setSelectedControl(type);
    flyToMeshRef.current?.(mesh, type.toUpperCase());
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf5f5f5);

    const camera = new THREE.PerspectiveCamera(
      60,
      mount.clientWidth / mount.clientHeight,
      0.1,
      5000
    );

    camera.position.set(0, 18, 45);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    mount.appendChild(renderer.domElement);

    const popup = document.createElement("div");
    popup.style.position = "absolute";
    popup.style.zIndex = "40";
    popup.style.padding = "9px 12px";
    popup.style.borderRadius = "10px";
    popup.style.fontWeight = "700";
    popup.style.fontSize = "13px";
    popup.style.pointerEvents = "none";
    popup.style.boxShadow = "0 8px 22px rgba(0,0,0,0.25)";
    popup.style.background = "#ffffff";
    popup.style.color = "#111827";
    popup.style.border = "1px solid #d1d5db";
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
    controlsRef.current = controls;

    scene.add(new THREE.AmbientLight(0xffffff, 1.8));

    const directionalLight1 = new THREE.DirectionalLight(0xffffff, 1.2);
    directionalLight1.position.set(50, 60, 40);
    scene.add(directionalLight1);

    const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight2.position.set(-40, 30, -30);
    scene.add(directionalLight2);

    scene.add(new THREE.GridHelper(200, 50));

    const modelGroup = new THREE.Group();
    scene.add(modelGroup);
    modelGroupRef.current = modelGroup;

    const pivot = new THREE.Group();
    modelGroup.add(pivot);

    const loader = new GLTFLoader();
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    let animationId = null;

    const isRedMesh = (mesh) => {
      if (!mesh?.material) return false;

      const materials = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];

      return materials.some((mat) => {
        if (!mat.color) return false;
        return mat.color.r > 0.7 && mat.color.g < 0.35 && mat.color.b < 0.35;
      });
    };

    const normalizeMeshMaterial = (mesh) => {
      if (!mesh.isMesh || !mesh.material) return;

      const oldMaterials = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];

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
        if ("color" in mat) mat.color.setHex(0xff0000);
        if ("emissive" in mat) {
          mat.emissive.setHex(0xff0000);
          mat.emissiveIntensity = 1.4;
        }
      });

      lastHighlightedRef.current = mesh;
    };

    const restoreTransparency = () => {
      transparentObjectsRef.current.forEach(({ mesh, original }) => {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

        materials.forEach((mat, index) => {
          const item = original[index];
          if (!item) return;

          mat.transparent = item.transparent;
          mat.opacity = item.opacity;
          mat.depthWrite = item.depthWrite;
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

        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];

        const original = materials.map((mat) => ({
          transparent: mat.transparent,
          opacity: mat.opacity,
          depthWrite: mat.depthWrite,
        }));

        materials.forEach((mat) => {
          mat.transparent = true;
          mat.opacity = 0.12;
          mat.depthWrite = false;
        });

        transparentObjectsRef.current.push({ mesh: child, original });
      });
    };

    const fitCameraToObject = () => {
      restoreTransparency();

      const box = new THREE.Box3().setFromObject(modelGroup);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());

      const maxDim = Math.max(size.x, size.y, size.z) || 20;
      const distance = maxDim * 1.8;

      controls.target.set(center.x, center.y + size.y * 0.2, center.z);
      camera.position.set(center.x, center.y + size.y * 0.45, center.z + distance);
      camera.lookAt(controls.target);
      controls.update();

      if (popupRef.current) popupRef.current.style.display = "none";
      selectedObjectRef.current = null;
    };

    const insideView = () => {
      makeWallTransparent();

      const box = new THREE.Box3().setFromObject(modelGroup);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());

      camera.position.set(center.x, center.y + Math.max(2, size.y * 0.25), center.z + 8);
      controls.target.set(center.x, center.y + Math.max(1, size.y * 0.2), center.z);
      camera.lookAt(controls.target);
      controls.update();
    };

    const moveCameraToMesh = (mesh) => {
      if (!mesh) return;

      makeWallTransparent();

      const box = new THREE.Box3().setFromObject(mesh);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());

      const distance = Math.max(6, Math.max(size.x, size.y, size.z) * 5);

      camera.position.set(
        center.x,
        center.y + Math.max(2, size.y * 1.5),
        center.z + distance
      );

      controls.target.set(center.x, center.y + size.y * 0.3, center.z);
      camera.lookAt(controls.target);
      controls.update();
    };

    flyToMeshRef.current = (mesh, label = "") => {
      selectedObjectRef.current = mesh;
      setSelectedName(label || cleanName(mesh?.name));
      setSelectedControl(detectDeviceType(label || mesh?.name, mesh));
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
        light: [],
        motion: [],
        sensor: [],
        touch: [],
        rfid: [],
      };

      root.traverse((child) => {
        if (!child.isMesh) return;

        const originalName = cleanName(child.name);
const manualAC =
MANUAL_DEVICE_MESH_NAMES.ac.some(
(item)=>
item.toLowerCase()===
originalName.toLowerCase()
);

const manualPanasonic =
MANUAL_DEVICE_MESH_NAMES.panasonicAc.some(
(item)=>
item.toLowerCase()===
originalName.toLowerCase()
);

const redBeforeNormalize =
isRedMesh(child);

normalizeMeshMaterial(child);

if(manualPanasonic){

child.name="Panasonic AC";

meshMapRef.current.panasonicAc=
child;

return;

}

if(
manualAC||
redBeforeNormalize
){

child.name="AC";

meshMapRef.current.ac=
child;

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
          meshMapRef.current[type] = candidates[type].sort(
            (a, b) => b.score - a.score
          )[0].mesh;
        }
      });

      console.log("Device mesh map:", {
        ac: meshMapRef.current.ac?.name,
        light: meshMapRef.current.light?.name,
        motion: meshMapRef.current.motion?.name,
        sensor: meshMapRef.current.sensor?.name,
        touch: meshMapRef.current.touch?.name,
        rfid: meshMapRef.current.rfid?.name,
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

if (type === "ac") {
  popupEl.style.pointerEvents = "none";

  popupEl.innerHTML = `
    <div style="font-weight:700;">AC</div>
    <div>Status: ${data.ac || "OFF"} | ${data.acTemp || 24}°C</div>
    <div style="font-size:11px; margin-top:4px;">
      Click red/green AC object to toggle
    </div>
  `;

  popupEl.style.background = data.ac === "ON" ? "#dcfce7" : "#fee2e2";
  popupEl.style.color = data.ac === "ON" ? "#166534" : "#991b1b";
  popupEl.style.border =
    data.ac === "ON" ? "1px solid #86efac" : "1px solid #fecaca";
} else if (type === "light") {
  popupEl.style.pointerEvents = "none";

  popupEl.innerHTML = `Light<br/>Status: ${data.light || "OFF"}`;
  popupEl.style.background = data.light === "ON" ? "#dcfce7" : "#fef3c7";
  popupEl.style.color = data.light === "ON" ? "#166534" : "#92400e";
  popupEl.style.border =
    data.light === "ON" ? "1px solid #86efac" : "1px solid #fde68a";
} else {
  popupEl.style.pointerEvents = "none";

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
const updateACObjectColor=()=>{

const updateColor=(mesh,status)=>{

if(!mesh?.material)return;

const materials=
Array.isArray(mesh.material)
?
mesh.material
:
[mesh.material];

materials.forEach((mat)=>{

mat.color.set(
status==="ON"
?
"#22c55e"
:
"#ff0000"
);

mat.userData.originalColor=
mat.color.clone();

});

};

updateColor(
meshMapRef.current.ac,
latestDeviceDataRef.current.ac
);

updateColor(
meshMapRef.current.panasonicAc,
latestDeviceDataRef.current.panasonicAc
);

};


    const handleCanvasClick = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();

      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);

      const intersects = raycaster.intersectObject(modelGroup, true);

      if (!intersects.length) return;

const clickedMesh = intersects[0].object;
const type = detectDeviceType(
clickedMesh.name,
clickedMesh
);

if(type==="panasonicAc"){

const nextState=

latestDeviceDataRef.current
.panasonicAc==="ON"
?
"OFF"
:
"ON";

controlPanasonicAC(
nextState
);

selectedObjectRef.current=
clickedMesh;

setSelectedName(
"Panasonic AC"
);

setSelectedControl(
"panasonicAc"
);

highlightMesh(
clickedMesh
);

return;
}

if(type==="ac"){

const nextState=

latestDeviceDataRef.current
.ac==="ON"
?
"OFF"
:
"ON";

controlAC(
nextState
);

selectedObjectRef.current=
clickedMesh;

setSelectedName(
"AC"
);

setSelectedControl(
"ac"
);

highlightMesh(
clickedMesh
);

return;
}
      const label =
        type === "ac"
          ? "AC"
          : type === "light"
          ? "Light"
          : cleanName(clickedMesh.name);

      selectedObjectRef.current = clickedMesh;
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

          setLoadError("");
          setLoadedFile(modelPath);
        },
        undefined,
        (error) => {
          console.error("Failed to load GLTF:", error);
          setLoadError(
            "GLTF file load failed. Put smartroomapp.gltf and linked files in public/models."
          );
        }
      );
    };

    loadModel();

    const createButton = (text, left, onClick) => {
      const button = document.createElement("button");
      button.innerText = text;
      button.style.position = "absolute";
      button.style.top = "20px";
      button.style.left = left;
      button.style.zIndex = "30";
      button.style.padding = "8px 12px";
      button.style.border = "1px solid #ccc";
      button.style.background = "#fff";
      button.style.cursor = "pointer";
      button.style.borderRadius = "6px";
      button.onclick = onClick;
      mount.appendChild(button);
      return button;
    };

    const frontButton = createButton("Front View", "20px", () => {
      fitCameraToObject();
      clearHighlight();
      setSelectedName("None");
      setSelectedControl("");
    });

    const insideButton = createButton("Inside View", "120px", () => {
      insideView();
    });

    const resetButton = createButton("Reset", "225px", () => {
      fitCameraToObject();
      clearHighlight();
      setSelectedName("None");
      setSelectedControl("");
    });

    renderer.domElement.addEventListener("click", handleCanvasClick);

    const animate = () => {
      animationId = requestAnimationFrame(animate);
     controls.update();
updateACObjectColor();
updatePopup();
renderer.render(scene, camera);
    };

    animate();

    const handleResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      renderer.domElement.removeEventListener("click", handleCanvasClick);

      if (animationId) cancelAnimationFrame(animationId);

      clearHighlight();
      restoreTransparency();
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
  }, []);

  const devices = [
    {
      id: "temperature",
      label: "Temperature",
      value: `${deviceData.temperature} °C`,
      type: "ac",
    },
    {
      id: "humidity",
      label: "Humidity",
      value: `${deviceData.humidity} %`,
      type: "",
    },
    {
      id: "motion",
      label: "Motion",
      value: deviceData.motion,
      type: "motion",
    },
    {
      id: "distance",
      label: "Distance",
      value: deviceData.distance,
      type: "",
    },
    {
      id: "ldr",
      label: "LDR",
      value: deviceData.ldr,
      type: "light",
    },
    {
      id: "ir",
      label: "IR",
      value: deviceData.ir,
      type: "sensor",
    },
    {
      id: "touch",
      label: "Touch",
      value: deviceData.touch,
      type: "touch",
    },
    {
      id: "rfid",
      label: "RFID",
      value: deviceData.rfid,
      type: "rfid",
    },
    {
      id: "light",
      label: "Light",
      value: deviceData.light,
      type: "light",
    },
    {
      id: "ac",
      label: "AC",
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
    <div style={{ display: "flex", width: "100%", height: "100vh" }}>
      <div
        ref={mountRef}
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
        }}
      />

      <div
        style={{
          width: "390px",
          background: "#ffffff",
          borderLeft: "1px solid #ddd",
          padding: "20px",
          fontFamily: "Arial, sans-serif",
          overflowY: "auto",
        }}
      >
        <h3 style={{ marginTop: 0 }}>Smart Room Panel</h3>

        {/* {loadedFile && (
          <div
            style={{
              marginBottom: "14px",
              padding: "10px",
              background: "#eef6ff",
              border: "1px solid #cfe3ff",
              borderRadius: "8px",
              color: "#1d4ed8",
              fontSize: "13px",
            }}
          >
            Loaded file: {loadedFile}
          </div>
        )} */}

        {loadError && (
          <div
            style={{
              marginBottom: "14px",
              padding: "10px",
              background: "#fee2e2",
              border: "1px solid #fecaca",
              borderRadius: "8px",
              color: "#991b1b",
            }}
          >
            {loadError}
          </div>
        )}

        <div
          style={{
            marginBottom: "14px",
            padding: "10px",
            background: "#eef6ff",
            border: "1px solid #cfe3ff",
            borderRadius: "8px",
          }}
        >
          <strong>Selected:</strong> {selectedName || "None"}
        </div>

        <div
          style={{
            marginBottom: "16px",
            padding: "14px",
            border: "1px solid #e5e7eb",
            borderRadius: "14px",
            background: "#f9fafb",
          }}
        >
          <h4 style={{ marginTop: 0, marginBottom: "12px" }}>
            Real-Time Device Data
          </h4>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "10px",
            }}
          >
            {devices.map((device) => (
              <div
                key={device.id}
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
                style={{
                  padding: "12px",
                  borderRadius: "12px",
                  border: "1px solid #e5e7eb",
                  background: "#ffffff",
                  cursor: device.type ? "pointer" : "default",
                }}
              >
                <div style={{ fontSize: "12px", color: "#6b7280" }}>
                  {device.label}
                </div>

                <div
                  style={{
                    marginTop: "6px",
                    fontSize: "17px",
                    fontWeight: 700,
                    color: "#111827",
                  }}
                >
                  {device.value}
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: "12px", fontSize: "12px", color: "#6b7280" }}>
            Last Update:{" "}
            {deviceData.updatedAt
              ? new Date(deviceData.updatedAt).toLocaleTimeString()
              : "--"}
          </div>
        </div>

        {selectedControl === "light" && (
          <div
            style={{
              marginBottom: "16px",
              padding: "14px",
              border: "1px solid #dbeafe",
              borderRadius: "10px",
              background: "#eff6ff",
            }}
          >
            <h4 style={{ marginTop: 0 }}>Light Control</h4>

            <p>
              Current Status: <strong>{deviceData.light}</strong>
            </p>

            <div style={{ display: "flex", gap: "10px" }}>
              <button
                onClick={() => controlLight("ON")}
                disabled={sending}
                style={buttonStyle}
              >
                Light ON
              </button>

              <button
                onClick={() => controlLight("OFF")}
                disabled={sending}
                style={buttonStyle}
              >
                Light OFF
              </button>
            </div>
          </div>
        )}

        {selectedControl === "ac" && (
          <div
            style={{
              marginBottom: "16px",
              padding: "14px",
              border: "1px solid #dcfce7",
              borderRadius: "10px",
              background: "#f0fdf4",
            }}
          >
            <h4 style={{ marginTop: 0 }}>Mitsubishi AC Control</h4>

            <p>
              Current Status: <strong>{deviceData.ac}</strong>
            </p>

            <p>
              Current Temp: <strong>{deviceData.acTemp} °C</strong>
            </p>

            <div style={{ display: "flex", gap: "10px", marginBottom: "10px" }}>
              <button
                onClick={() => controlAC("ON")}
                disabled={sending}
                style={buttonStyle}
              >
                AC ON
              </button>

              <button
                onClick={() => controlAC("OFF")}
                disabled={sending}
                style={buttonStyle}
              >
                AC OFF
              </button>
            </div>

            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {[18, 20, 22, 24, 26].map((temp) => (
                <button
                  key={temp}
                  onClick={() => controlACTemp(temp)}
                  disabled={sending}
                  style={smallButtonStyle}
                >
                  {temp}°C
                </button>
              ))}
            </div>
          </div>
        )}

        {controlMessage && (
          <div
            style={{
              marginBottom: "14px",
              padding: "10px",
              background: "#f0fdf4",
              border: "1px solid #bbf7d0",
              borderRadius: "8px",
              color: "#166534",
            }}
          >
            {controlMessage}
          </div>
        )}
      </div>
    </div>
  );
}