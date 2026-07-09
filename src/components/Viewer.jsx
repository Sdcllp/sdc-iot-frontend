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
  ✅ EXACT OBJECT MAPPING AS PER YOUR MODEL

  AC          = Object WIN 1 5
  LDR         = object 3 0 x 6 8
  LIGHTS      = Object SONO FLEX 350 trim, 3000 K, non DIM, 063 32385170 7
  MOTION      = object name "Light"
  TEMPERATURE = Side table - 2

  ✅ Only these mapped objects are selectable.
  ✅ Other room objects, walls, chair, door, table etc. will not select.
*/

const DEVICE_MATCHERS = {
  ac: ["objectwin15", "win15"],

  // LDR actual exported name can become Object 3 0 x 6 8 / Object 3.0 x 6.8 / Object 3_0 x 6_8
  ldr: ["object30x68", "30x68", "object3068", "3068", "object3x68", "3x68"],

  light: [
    "objectsonoflex350trim3000knondim063323851707",
    "sonoflex350trim3000knondim063323851707",
    "sonoflex",
  ],

  // Important: in your GLB the object named Light is Motion, not light.
  motion: [
    "occupancy sensor",
    "light",
    "objectlight",
    "motionsensor",
    "motionsensor",
    "pir",
    "sensor",
    "occupancy",
    "los",
    "lutron",
    "loscir1500",
  ],

  temperature: ["sidetable2", "sidetable02", "sidetable"],
};

const cleanName = (name = "") =>
  String(name || "")
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .replace(/\./g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Object";

const compactName = (name = "") =>
  cleanName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const isMatch = (name, type) => {
  const compact = compactName(name);
  const exact = cleanName(name).toLowerCase();

  if (type === "motion") {
    // Object named exactly "Light" should be Motion.
    return (
      exact === "light" || compact === "motionsensor" || compact.includes("pir")
    );
  }

  return DEVICE_MATCHERS[type].some((key) => compact.includes(key));
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
    motion: "--",
    ldr: "--",
    light: "OFF",
    ac: "OFF",
    acTemp: 24,
    updatedAt: null,
  });

  const meshMapRef = useRef({});
  const allMeshesRef = useRef([]);
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
    if (mesh?.userData?.deviceType) return mesh.userData.deviceType;

    for (const type of ["ac", "ldr", "light", "motion", "temperature"]) {
      if (isMatch(name, type)) return type;
    }

    return "";
  };

  const goToDevice = (type) => {
    const mesh = meshMapRef.current[type];

    if (!mesh) {
      setSelectedControl(type);
      setControlMessage(`${type.toUpperCase()} object not found in model`);
      console.warn("Device object not found:", type, {
        mapped: meshMapRef.current,
        allNames: allMeshesRef.current.map((m) => m.name),
      });
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

    const camera = new THREE.PerspectiveCamera(
      60,
      mount.clientWidth / mount.clientHeight,
      0.1,
      5000,
    );
    camera.position.set(0, 18, 45);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
    controls.rotateSpeed = 0.8;
    controls.zoomSpeed = 1.2;
    controls.panSpeed = 0.8;
    controls.minDistance = 0.001;
    controls.maxDistance = 500;
    controls.target.set(0, 0, 0);

    const ambient = new THREE.AmbientLight(0xffffff, 3.5);
    scene.add(ambient);

    const light1 = new THREE.DirectionalLight(0xffffff, 4);
    light1.position.set(20, 40, 20);
    scene.add(light1);

    const light2 = new THREE.DirectionalLight(0xffffff, 3);
    light2.position.set(-20, 20, -20);
    scene.add(light2);

    const gridHelper = new THREE.GridHelper(200, 50);
    gridHelper.visible = false; // Hide grid
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

    const moveKeys = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      up: false,
      down: false,
      run: false,
    };

    const fpsClock = new THREE.Clock();
    let fpsYaw = 0;
    let fpsPitch = 0;
    let pointerLocked = false;

    const setFPSRotation = () => {
      camera.rotation.order = "YXZ";
      camera.rotation.y = fpsYaw;
      camera.rotation.x = fpsPitch;
      camera.rotation.z = 0;
    };

    const syncFPSRotationFromCamera = () => {
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      fpsYaw = Math.atan2(-dir.x, -dir.z);
      fpsPitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      setFPSRotation();
    };

    const requestFPSLock = () => {
      if (!isInsideMode) return;

      controls.enabled = false;
      syncFPSRotationFromCamera();

      if (
        document.pointerLockElement !== renderer.domElement &&
        renderer.domElement.requestPointerLock
      ) {
        renderer.domElement.requestPointerLock();
      }
    };

    const normalizeMeshMaterial = (mesh) => {
      if (!mesh.isMesh || !mesh.material) return;

      const materials = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];

      materials.forEach((mat) => {
        if (!mat.userData.originalColor && mat.color) {
          mat.userData.originalColor = mat.color.clone();
        }

        mat.side = THREE.DoubleSide;

        if ("roughness" in mat)
          mat.roughness = Math.min(mat.roughness ?? 1, 0.8);
        if ("metalness" in mat)
          mat.metalness = Math.max(mat.metalness ?? 0, 0.05);

        mat.needsUpdate = true;
      });

      mesh.castShadow = true;
      mesh.receiveShadow = true;
    };

    const clearHighlight = () => {
      const last = lastHighlightedRef.current;
      if (!last?.material) return;

      const materials = Array.isArray(last.material)
        ? last.material
        : [last.material];

      materials.forEach((mat) => {
        if (mat.userData?.originalColor)
          mat.color.copy(mat.userData.originalColor);

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

      const materials = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];

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

        const materials = Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material];

        materials.forEach((mat, index) => {
          const item = original.materials?.[index];
          if (!item) return;

          mat.transparent = item.transparent;
          mat.opacity = item.opacity;
          mat.depthWrite = item.depthWrite;
          mat.side = item.side;
          mat.needsUpdate = true;
        });
      });

      transparentObjectsRef.current = [];
    };

    const makeWallTransparent = () => {
      restoreTransparency();

      modelGroup.traverse((child) => {
        if (!child.isMesh || !child.material || child.userData?.isDevice)
          return;

        const name = cleanName(child.name).toLowerCase();
        const box = new THREE.Box3().setFromObject(child);
        const size = box.getSize(new THREE.Vector3());

        const isWallLike =
          name.includes("wall") ||
          name.includes("panel") ||
          name.includes("front") ||
          name.includes("glass") ||
          name.includes("window") ||
          name.includes("door") ||
          size.x > size.z * 2.5 ||
          size.z > size.x * 2.5;

        if (!isWallLike) return;

        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];

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
          mat.opacity = 0.12;
          mat.depthWrite = false;
          mat.side = THREE.DoubleSide;
          mat.needsUpdate = true;
        });

        transparentObjectsRef.current.push({ mesh: child, original });
      });
    };

    const fitCameraToObject = () => {
      isInsideMode = false;
      insideBox = null;

      restoreTransparency();
      gridHelper.visible = false;

      controls.enabled = true;
      controls.enablePan = true;
      controls.enableZoom = true;
      controls.enableRotate = true;
      controls.minDistance = 0.1;
      controls.maxDistance = 500;

      const box = new THREE.Box3().setFromObject(modelGroup);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 20;
      const distance = maxDim * 1.45;

      controls.target.set(box.max.x, center.y + size.y * 0.32, center.z);
      camera.position.set(
        box.max.x + distance,
        center.y + size.y * 0.36,
        center.z,
      );

      camera.fov = 45;
      camera.near = 0.01;
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

      modelGroup.traverse((child) => {
        if (!child.isMesh || !child.material) return;

        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];

        materials.forEach((mat) => {
          mat.side = THREE.DoubleSide;
          mat.transparent = false;
          mat.opacity = 1;
          mat.depthWrite = true;
          mat.needsUpdate = true;
        });
      });

      const eyeHeight = center.y + size.y * 0.18;

      camera.position.set(center.x, eyeHeight, center.z + size.z * 0.15);
      controls.target.set(center.x, eyeHeight, center.z - 0.01);

      camera.fov = 80;
      camera.near = 0.01;
      camera.far = 5000;
      camera.updateProjectionMatrix();

      controls.enableRotate = true;
      controls.enableZoom = false;
      controls.enablePan = false;
      controls.minDistance = 0.01;
      controls.maxDistance = 0.01;
      controls.rotateSpeed = 0.6;
      controls.update();

      controls.enabled = false;
      syncFPSRotationFromCamera();

      renderer.domElement.setAttribute("tabindex", "0");
      renderer.domElement.focus();

      // Pointer lock browser user gesture ke bina allowed nahi hota.
      // Mouse look ke liye inside view me double-click karo.

      selectedObjectRef.current = null;
      if (popupRef.current) popupRef.current.style.display = "none";
    };

    const moveCameraToMesh = (mesh) => {
      if (!mesh) return;

      restoreTransparency();
      gridHelper.visible = false;

      if (document.pointerLockElement === renderer.domElement) {
        document.exitPointerLock();
      }

      const meshBox = new THREE.Box3().setFromObject(mesh);
      const center = meshBox.getCenter(new THREE.Vector3());
      const meshSize = meshBox.getSize(new THREE.Vector3());

      const roomBox = new THREE.Box3().setFromObject(modelGroup);
      const roomCenter = roomBox.getCenter(new THREE.Vector3());
      const roomSize = roomBox.getSize(new THREE.Vector3());

      const type = detectDeviceType(mesh.name, mesh);
      const maxMeshSize = Math.max(meshSize.x, meshSize.y, meshSize.z) || 1;
      const roomDistance = Math.max(roomSize.x, roomSize.y, roomSize.z) || 20;

      let cameraPos;

      if (type === "light" || type === "motion") {
        // Ceiling objects: show from below, not too close.
        cameraPos = new THREE.Vector3(
          center.x,
          center.y - Math.max(3.5, roomDistance * 0.18),
          center.z + Math.max(2.5, roomDistance * 0.1),
        );
        camera.fov = 58;
      } else if (type === "temperature") {
        // Temperature/side-table: keep a comfortable room view.
        let dir = new THREE.Vector3().subVectors(roomCenter, center);
        dir.y = 0;
        if (dir.lengthSq() < 0.0001) dir.set(0, 0, 1);
        dir.normalize();

        cameraPos = new THREE.Vector3(
          center.x + dir.x * Math.max(4.5, roomDistance * 0.16),
          center.y + Math.max(1.8, maxMeshSize * 1.5),
          center.z + dir.z * Math.max(4.5, roomDistance * 0.16),
        );
        camera.fov = 48;
      } else {
        // AC / LDR / other mapped device: view from inside room side.
        let dir = new THREE.Vector3().subVectors(roomCenter, center);
        dir.y = 0;
        if (dir.lengthSq() < 0.0001) dir.set(0, 0, 1);
        dir.normalize();

        cameraPos = new THREE.Vector3(
          center.x + dir.x * Math.max(5.5, roomDistance * 0.18),
          center.y + Math.max(1.5, maxMeshSize * 1.8),
          center.z + dir.z * Math.max(5.5, roomDistance * 0.18),
        );
        camera.fov = type === "ldr" ? 45 : 48;
      }

      // Keep camera inside model bounding box so it never goes extremely outside.
      cameraPos.x = THREE.MathUtils.clamp(
        cameraPos.x,
        roomBox.min.x + 0.6,
        roomBox.max.x - 0.6,
      );
      cameraPos.y = THREE.MathUtils.clamp(
        cameraPos.y,
        roomBox.min.y + 0.9,
        roomBox.max.y - 0.4,
      );
      cameraPos.z = THREE.MathUtils.clamp(
        cameraPos.z,
        roomBox.min.z + 0.6,
        roomBox.max.z - 0.6,
      );

      camera.position.copy(cameraPos);
      camera.near = 0.01;
      camera.far = 5000;
      camera.updateProjectionMatrix();
      camera.lookAt(center);

      selectedObjectRef.current = mesh;

      // Important: after object selection, keep FPS/inside movement active.
      isInsideMode = true;
      insideBox = roomBox.clone();

      controls.enabled = false;
      controls.enableRotate = false;
      controls.enableZoom = false;
      controls.enablePan = false;
      controls.target.copy(center);

      syncFPSRotationFromCamera();

      renderer.domElement.setAttribute("tabindex", "0");
      renderer.domElement.focus();
    };

    flyToMeshRef.current = (mesh, label = "") => {
      selectedObjectRef.current = mesh;

      const type = detectDeviceType(label || mesh?.name, mesh);

      const finalLabel =
        type === "temperature"
          ? "Temperature"
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
      if (type === "temperature") {
        clearHighlight();
      } else {
        highlightMesh(mesh);
      }
      moveCameraToMesh(mesh);
    };

    const centerAndGroundModel = () => {
      pivot.rotation.set(0, 0, 0);

      const box = new THREE.Box3().setFromObject(pivot);
      const center = box.getCenter(new THREE.Vector3());

      pivot.position.sub(center);

      const box2 = new THREE.Box3().setFromObject(pivot);
      const size = box2.getSize(new THREE.Vector3());

      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 30 / maxDim;

      pivot.scale.setScalar(scale);

      const box3 = new THREE.Box3().setFromObject(pivot);
      pivot.position.y -= box3.min.y;
    };

    const assignDevice = (type, mesh) => {
      if (!mesh) return;

      mesh.userData.deviceType = type;
      mesh.userData.isDevice = true;

      mesh.name =
        type === "ac"
          ? "AC"
          : type === "light"
            ? "Light"
            : type === "motion"
              ? "Motion Sensor"
              : type === "temperature"
                ? "Temperature Sensor"
                : type === "ldr"
                  ? "LDR"
                  : mesh.name;

      // Main button target: first matched object only.
      if (!meshMapRef.current[type]) {
        meshMapRef.current[type] = mesh;
      }
    };

    const buildDeviceMap = (root) => {
      meshMapRef.current = {};
      allMeshesRef.current = [];

      root.traverse((child) => {
        if (!child.isMesh) return;

        normalizeMeshMaterial(child);

        const originalName = cleanName(child.name);
        const compact = compactName(originalName);
        const lower = originalName.toLowerCase();

        allMeshesRef.current.push({
          name: originalName,
          compact,
          mesh: child,
        });

        // ✅ Exact mapping
        if (isMatch(originalName, "ac")) {
          assignDevice("ac", child);
          return;
        }

        // ✅ LDR robust matching:
        // Supports Object 3 0 x 6 8, Object 3.0 x 6.8, Object_3_0_x_6_8, Object3068 etc.
        if (
          isMatch(originalName, "ldr") ||
          compact.includes("30x68") ||
          compact.includes("3068") ||
          compact.includes("3x68") ||
          (compact.includes("object") &&
            compact.includes("3") &&
            compact.includes("6") &&
            compact.includes("8") &&
            compact.includes("x"))
        ) {
          assignDevice("ldr", child);
          return;
        }

        if (isMatch(originalName, "temperature")) {
          assignDevice("temperature", child);
          return;
        }

        // ✅ Important order:
        // SONO FLEX = real lights
        // Exact object name "Light" = Motion sensor
        if (isMatch(originalName, "light")) {
          assignDevice("light", child);
          return;
        }

        if (
          isMatch(originalName, "motion") ||
          lower.includes("occupancy sensor") ||
          lower.includes("lutron") ||
          lower.includes("los")
        ) {
          assignDevice("motion", child);
          return;
        }
      });

      console.log("✅ Device mesh map:", {
        ac: meshMapRef.current.ac?.name,
        ldr: meshMapRef.current.ldr?.name,
        light: meshMapRef.current.light?.name,
        motion: meshMapRef.current.motion?.name,
        temperature: meshMapRef.current.temperature?.name,
      });

      console.log(
        "🔎 All mesh names:",
        allMeshesRef.current.map((item) => item.name),
      );
      allMeshesRef.current.forEach((item) => {
        console.log("Mesh:", item.name);
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
        `;
        popupEl.style.background = "#ffffff";
        popupEl.style.color = "#111827";
        popupEl.style.border = "1px solid #86efac";
      } else if (type === "ac") {
        popupEl.innerHTML = `
          <div style="font-weight:700;">AC</div>
          <div>Status: ${data.ac || "OFF"} | ${data.acTemp || 24}°C</div>
          <div style="font-size:11px; margin-top:4px;">Click AC object to toggle</div>
        `;
        popupEl.style.background = data.ac === "ON" ? "#dcfce7" : "#fee2e2";
        popupEl.style.color = data.ac === "ON" ? "#166534" : "#991b1b";
        popupEl.style.border =
          data.ac === "ON" ? "1px solid #86efac" : "1px solid #fecaca";
      } else if (type === "temperature") {
        popupEl.innerHTML = `
          <div style="font-weight:700;">Temperature</div>
          <div>${data.temperature || "--"} °C</div>
        `;
        popupEl.style.background = "#e0f2fe";
        popupEl.style.color = "#075985";
        popupEl.style.border = "1px solid #7dd3fc";
      } else if (type === "light") {
        popupEl.innerHTML = `
          <div style="font-weight:700;">Light</div>
          <div>Status: ${data.light || "OFF"}</div>
          <div style="font-size:11px; margin-top:4px;">Click light object to toggle</div>
        `;
        popupEl.style.background = data.light === "ON" ? "#dcfce7" : "#fef3c7";
        popupEl.style.color = data.light === "ON" ? "#166534" : "#92400e";
        popupEl.style.border =
          data.light === "ON" ? "1px solid #86efac" : "1px solid #fde68a";
      } else if (type === "ldr") {
        popupEl.innerHTML = `
          <div style="font-weight:700;">LDR Sensor</div>
          <div>Value : ${data.ldr || "--"}</div>
        `;
        popupEl.style.background = "#e0f2fe";
        popupEl.style.color = "#075985";
        popupEl.style.border = "1px solid #7dd3fc";
      } else {
        popupEl.style.display = "none";
        return;
      }

      popupEl.style.left = `${x}px`;
      popupEl.style.top = `${y}px`;
      popupEl.style.transform = "translate(-50%, -120%)";
      popupEl.style.display = "block";
    };

    const updateDeviceObjectColors = () => {
      const updateColor = (mesh, status) => {
        if (!mesh?.material) return;

        const materials = Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material];

        materials.forEach((mat) => {
          if (!mat.userData.originalColor && mat.color) {
            mat.userData.originalColor = mat.color.clone();
          }

          mat.color.set(status === "ON" ? "#22c55e" : "#ff0000");
          mat.needsUpdate = true;
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

      // ✅ ONLY mapped IoT objects are selectable.
      const clicked = intersects.find((hit) => hit.object?.userData?.isDevice);
      if (!clicked) return;

      const clickedMesh = clicked.object;
      const type = detectDeviceType(clickedMesh.name, clickedMesh);

      if (!type) return;

      selectedObjectRef.current = clickedMesh;

      if (type === "ac") {
        const nextState =
          latestDeviceDataRef.current.ac === "ON" ? "OFF" : "ON";
        controlAC(nextState);
        setSelectedName("AC");
        setSelectedControl("ac");
        highlightMesh(clickedMesh);
        moveCameraToMesh(clickedMesh);
        return;
      }

      if (type === "light") {
        const nextState =
          latestDeviceDataRef.current.light === "ON" ? "OFF" : "ON";
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

        // Temperature ka original color hi rahega
        clearHighlight();

        moveCameraToMesh(clickedMesh);
        return;
      }

      if (type === "ldr") {
        setSelectedName("LDR");
        setSelectedControl("ldr");
        highlightMesh(clickedMesh);
        moveCameraToMesh(clickedMesh);
      }
    };

    const loadModel = () => {
      const modelPath = `${process.env.PUBLIC_URL}/models/3dExport.glb`;

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

          setLoadError("");
          setLoadedFile(modelPath);
        },
        undefined,
        (error) => {
          console.error("Failed to load GLTF:", error);
          setLoadError(
            "GLTF file load failed. Put 3dExport.glb in public/models.",
          );
        },
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

    const setMoveKey = (event, pressed) => {
      const key = event.key.toLowerCase();

      if (key === "w" || key === "arrowup") moveKeys.forward = pressed;
      else if (key === "s" || key === "arrowdown") moveKeys.backward = pressed;
      else if (key === "a" || key === "arrowleft") moveKeys.left = pressed;
      else if (key === "d" || key === "arrowright") moveKeys.right = pressed;
      else if (key === "q") moveKeys.up = pressed;
      else if (key === "e") moveKeys.down = pressed;
      else if (key === "shift") moveKeys.run = pressed;
      else return;

      if (isInsideMode) event.preventDefault();
    };

    const handleKeyDown = (event) => setMoveKey(event, true);
    const handleKeyUp = (event) => setMoveKey(event, false);

    const handlePointerLockChange = () => {
      pointerLocked = document.pointerLockElement === renderer.domElement;
      if (isInsideMode) controls.enabled = false;
    };

    const handleMouseMove = (event) => {
      if (!isInsideMode || !pointerLocked) return;

      const sensitivity = 0.0022;
      fpsYaw -= event.movementX * sensitivity;
      fpsPitch -= event.movementY * sensitivity;

      const limit = Math.PI / 2 - 0.01;
      fpsPitch = THREE.MathUtils.clamp(fpsPitch, -limit, limit);

      setFPSRotation();
    };

    const handleCanvasDoubleClick = () => requestFPSLock();
    const handleFrontWheelEnter = (event) => {
      if (isInsideMode) return;

      const distance = camera.position.distanceTo(controls.target);

      if (event.deltaY < 0 && distance < 8) {
        event.preventDefault();
        insideView();
      }
    };
    const handleInsideWheel = (event) => {
      if (!isInsideMode || !insideBox) return;

      event.preventDefault();

      const direction = new THREE.Vector3();
      camera.getWorldDirection(direction);
      direction.y = 0;
      direction.normalize();

      const speed = 0.8;
      const move = event.deltaY > 0 ? -speed : speed;

      camera.position.addScaledVector(direction, move);
      controls.target.addScaledVector(direction, move);

      camera.position.x = THREE.MathUtils.clamp(
        camera.position.x,
        insideBox.min.x + 0.5,
        insideBox.max.x - 0.5,
      );
      camera.position.z = THREE.MathUtils.clamp(
        camera.position.z,
        insideBox.min.z + 0.5,
        insideBox.max.z - 0.5,
      );

      controls.update();
    };

    renderer.domElement.addEventListener("click", handleCanvasClick);
    renderer.domElement.addEventListener("wheel", handleInsideWheel, {
      passive: false,
    });
    renderer.domElement.addEventListener("wheel", handleFrontWheelEnter, {
      passive: false,
    });
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    document.addEventListener("pointerlockchange", handlePointerLockChange);
    document.addEventListener("mousemove", handleMouseMove);
    renderer.domElement.addEventListener("dblclick", handleCanvasDoubleClick);

    const animate = () => {
      animationId = requestAnimationFrame(animate);
      const delta = Math.min(fpsClock.getDelta(), 0.05);

      if (isInsideMode && insideBox) {
        controls.enabled = false;

        const speed = moveKeys.run ? 7.0 : 3.5;
        const step = speed * delta;

        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();

        const right = new THREE.Vector3();
        right.crossVectors(forward, camera.up).normalize();

        const movement = new THREE.Vector3();

        if (moveKeys.forward) movement.add(forward);
        if (moveKeys.backward) movement.sub(forward);
        if (moveKeys.right) movement.add(right);
        if (moveKeys.left) movement.sub(right);

        if (movement.lengthSq() > 0) {
          movement.normalize().multiplyScalar(step);
          camera.position.add(movement);
        }

        if (moveKeys.up) camera.position.y += step;
        if (moveKeys.down) camera.position.y -= step;

        camera.position.x = THREE.MathUtils.clamp(
          camera.position.x,
          insideBox.min.x + 0.6,
          insideBox.max.x - 0.6,
        );
        camera.position.z = THREE.MathUtils.clamp(
          camera.position.z,
          insideBox.min.z + 0.6,
          insideBox.max.z - 0.6,
        );
        camera.position.y = THREE.MathUtils.clamp(
          camera.position.y,
          insideBox.min.y + 0.8,
          insideBox.max.y - 0.5,
        );

        setFPSRotation();
      } else {
        controls.update();
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
      renderer.domElement.removeEventListener("wheel", handleInsideWheel);
      renderer.domElement.removeEventListener("wheel", handleFrontWheelEnter);

      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      document.removeEventListener(
        "pointerlockchange",
        handlePointerLockChange,
      );
      document.removeEventListener("mousemove", handleMouseMove);
      renderer.domElement.removeEventListener(
        "dblclick",
        handleCanvasDoubleClick,
      );

      if (document.pointerLockElement === renderer.domElement)
        document.exitPointerLock();
      if (animationId) cancelAnimationFrame(animationId);

      clearHighlight();
      restoreTransparency();
      gridHelper.visible = true;
      controls.dispose();
      renderer.dispose();

      [frontButton, insideButton, resetButton].forEach((button) => {
        if (button && mount.contains(button)) mount.removeChild(button);
      });

      if (popupRef.current && mount.contains(popupRef.current))
        mount.removeChild(popupRef.current);
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

        {loadedFile && (
          <div className="info-box">
            3D model loaded • Inside View: W/A/S/D move, Q up, E down, mouse
            look, Shift run, Esc unlock, double-click lock
          </div>
        )}

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
                    if (popupRef.current)
                      popupRef.current.style.display = "none";
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
            {deviceData.updatedAt
              ? new Date(deviceData.updatedAt).toLocaleTimeString()
              : "--"}
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

        {selectedControl === "motion" && (
          <div className="control-card">
            <h4>Motion Sensor</h4>
            <p>
              Current Motion: <strong>{deviceData.motion}</strong>
            </p>
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
