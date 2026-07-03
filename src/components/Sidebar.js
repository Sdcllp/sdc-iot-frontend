import React, { useState } from "react";

function Sidebar({ setFloor, setRoom }) {
  const [selectedFloor, setSelectedFloor] = useState(null);

  const rooms = Array.from(
    { length: 10 },
    (_, i) => (selectedFloor ? selectedFloor * 100 + 1 + i : i + 1)
  );

  const styles = {
    sidebar: {
      width: "280px",
      height: "100%",
      background: "linear-gradient(180deg, #1f2937 0%, #111827 100%)",
      color: "#fff",
      padding: "24px 18px",
      boxSizing: "border-box",
      boxShadow: "4px 0 20px rgba(0,0,0,0.25)",
      display: "flex",
      flexDirection: "column",
      fontFamily: "Arial, sans-serif",
    },
    header: {
      marginBottom: "25px",
      borderBottom: "1px solid rgba(255,255,255,0.08)",
      paddingBottom: "14px",
    },
    title: {
      fontSize: "22px",
      fontWeight: "700",
      margin: 0,
      letterSpacing: "0.5px",
    },
    subtitle: {
      fontSize: "13px",
      color: "#9ca3af",
      marginTop: "6px",
    },
    sectionTitle: {
      fontSize: "14px",
      fontWeight: "600",
      marginBottom: "12px",
      color: "#d1d5db",
      textTransform: "uppercase",
      letterSpacing: "0.8px",
    },
    button: {
      width: "100%",
      padding: "14px 16px",
      marginBottom: "12px",
      border: "none",
      borderRadius: "12px",
      background: "#374151",
      color: "#fff",
      textAlign: "left",
      fontSize: "15px",
      fontWeight: "500",
      cursor: "pointer",
      transition: "0.3s ease",
      boxShadow: "0 4px 10px rgba(0,0,0,0.15)",
    },
    activeButton: {
      background: "linear-gradient(90deg, #2563eb, #1d4ed8)",
      boxShadow: "0 6px 14px rgba(37, 99, 235, 0.35)",
    },
    roomContainer: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "10px",
      marginTop: "8px",
    },
    roomButton: {
      padding: "12px 10px",
      border: "none",
      borderRadius: "10px",
      background: "#2d3748",
      color: "#e5e7eb",
      fontSize: "14px",
      fontWeight: "500",
      cursor: "pointer",
      transition: "0.3s ease",
    },
    backButton: {
      marginTop: "18px",
      padding: "12px 14px",
      border: "1px solid rgba(255,255,255,0.12)",
      borderRadius: "10px",
      background: "transparent",
      color: "#d1d5db",
      fontSize: "14px",
      fontWeight: "600",
      cursor: "pointer",
    },
  };

  return (
    <div style={styles.sidebar}>
      <div style={styles.header}>
        <h2 style={styles.title}>Building Panel</h2>
        <div style={styles.subtitle}>
          Select floor and room
        </div>
      </div>

      {!selectedFloor ? (
        <>
          <div style={styles.sectionTitle}>Floors</div>

          <button
            style={styles.button}
            onClick={() => {
              setSelectedFloor(1);
              setFloor(1);
            }}
            onMouseOver={(e) => {
              e.target.style.background = "#4b5563";
            }}
            onMouseOut={(e) => {
              e.target.style.background = "#374151";
            }}
          >
            1st Floor
          </button>

          <button
            style={styles.button}
            onClick={() => {
              setSelectedFloor(2);
              setFloor(2);
            }}
            onMouseOver={(e) => {
              e.target.style.background = "#4b5563";
            }}
            onMouseOut={(e) => {
              e.target.style.background = "#374151";
            }}
          >
            2nd Floor
          </button>
        </>
      ) : (
        <>
          <div style={styles.sectionTitle}>Floor {selectedFloor} Rooms</div>

          <button
            style={{ ...styles.button, ...styles.activeButton }}
          >
            Selected: Floor {selectedFloor}
          </button>

          <div style={styles.roomContainer}>
            {rooms.map((room) => (
              <button
                key={room}
                style={styles.roomButton}
                onClick={() => setRoom(room)}
                onMouseOver={(e) => {
                  e.target.style.background = "#3b82f6";
                  e.target.style.color = "#fff";
                }}
                onMouseOut={(e) => {
                  e.target.style.background = "#2d3748";
                  e.target.style.color = "#e5e7eb";
                }}
              >
                Room {room}
              </button>
            ))}
          </div>

          <button
            style={styles.backButton}
            onClick={() => setSelectedFloor(null)}
            onMouseOver={(e) => {
              e.target.style.background = "rgba(255,255,255,0.08)";
            }}
            onMouseOut={(e) => {
              e.target.style.background = "transparent";
            }}
          >
            ← Back to Floors
          </button>
        </>
      )}
    </div>
  );
}

export default Sidebar;