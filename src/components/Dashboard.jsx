// import React, { useEffect, useState } from "react";
// import axios from "axios";

// function Dashboard() {
//   const [data, setData] = useState({
//     temperature: "--",
//     humidity: "--",
//     motion: "--",
//     distance: "--",
//     ldr: "--",
//     ir: "--",
//     touch: "--",
//     rfid: "--",
//     updatedAt: null,
//   });

//   const [error, setError] = useState("");

//   useEffect(() => {
//     const fetchData = async () => {
//       try {
//         const res = await axios.get("http://127.0.0.1:8080/api/data");
//         setData(res.data.data);
//         setError("");
//       } catch (err) {
//         console.error("Error fetching MQTT data:", err);
//         setError("Backend not connected on port 8080");
//       }
//     };

//     fetchData();
//     const interval = setInterval(fetchData, 2000);

//     return () => clearInterval(interval);
//   }, []);

//   const pageStyle = {
//     minHeight: "100vh",
//     background: "#f4f7fb",
//     padding: "30px",
//     fontFamily: "Arial, sans-serif",
//   };

//   const headerStyle = {
//     marginBottom: "20px",
//   };

//   const gridStyle = {
//     display: "grid",
//     gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
//     gap: "20px",
//   };

//   const cardStyle = {
//     background: "#fff",
//     borderRadius: "16px",
//     padding: "22px",
//     boxShadow: "0 6px 18px rgba(0,0,0,0.08)",
//     textAlign: "center",
//   };

//   const titleStyle = {
//     fontSize: "18px",
//     color: "#444",
//     marginBottom: "12px",
//   };

//   const valueStyle = {
//     fontSize: "28px",
//     fontWeight: "700",
//     color: "#111",
//     margin: 0,
//   };

//   const subStyle = {
//     color: "#666",
//     marginTop: "10px",
//     fontSize: "14px",
//   };

//   return (
//     <div style={pageStyle}>
//       <div style={headerStyle}>
//         <h2 style={{ margin: 0 }}>📡 Live IoT Dashboard</h2>
//         <p style={{ color: "#666", marginTop: "8px" }}>
//           Last Updated:{" "}
//           {data.updatedAt ? new Date(data.updatedAt).toLocaleString() : "--"}
//         </p>
//         {error && (
//           <p style={{ color: "red", marginTop: "10px", fontWeight: "bold" }}>
//             {error}
//           </p>
//         )}
//       </div>

//       <div style={gridStyle}>
//         <div style={cardStyle}>
//           <div style={titleStyle}>🌡 Temperature</div>
//           <p style={valueStyle}>
//             {data.temperature !== "--" ? `${data.temperature} °C` : "--"}
//           </p>
//         </div>

//         <div style={cardStyle}>
//           <div style={titleStyle}>💧 Humidity</div>
//           <p style={valueStyle}>
//             {data.humidity !== "--" ? `${data.humidity} %` : "--"}
//           </p>
//         </div>

//         <div style={cardStyle}>
//           <div style={titleStyle}>🚶 Motion</div>
//           <p style={valueStyle}>{data.motion}</p>
//         </div>

//         <div style={cardStyle}>
//           <div style={titleStyle}>📏 Distance</div>
//           <p style={valueStyle}>
//             {data.distance !== "--" ? `${data.distance} cm` : "--"}
//           </p>
//         </div>

//         <div style={cardStyle}>
//           <div style={titleStyle}>💡 LDR</div>
//           <p style={valueStyle}>{data.ldr}</p>
//           <div style={subStyle}>Light / Dark</div>
//         </div>

//         <div style={cardStyle}>
//           <div style={titleStyle}>📍 IR Sensor</div>
//           <p style={valueStyle}>{data.ir}</p>
//         </div>

//         <div style={cardStyle}>
//           <div style={titleStyle}>✋ Touch</div>
//           <p style={valueStyle}>{data.touch}</p>
//         </div>

//         <div style={cardStyle}>
//           <div style={titleStyle}>🪪 RFID</div>
//           <p
//             style={{ ...valueStyle, fontSize: "22px", wordBreak: "break-word" }}
//           >
//             {data.rfid}
//           </p>
//         </div>
//       </div>
//     </div>
//   );
// }

// export default Dashboard;
