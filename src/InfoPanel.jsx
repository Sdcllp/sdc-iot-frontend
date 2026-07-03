import React from "react";

export default function InfoPanel({ selectedObject, liveData }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 20,
        right: 20,
        width: 280,
        background: "rgba(255,255,255,0.95)",
        borderRadius: 12,
        padding: 16,
        boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
        fontFamily: "Arial, sans-serif",
        zIndex: 10,
      }}
    >
      <h3 style={{ marginTop: 0 }}>Object Info</h3>

      {!selectedObject ? (
        <p>Click a door or object.</p>
      ) : (
        <>
          <p>
            <strong>Name:</strong> {selectedObject.name}
          </p>
          <p>
            <strong>ID:</strong> {selectedObject.objectId}
          </p>
          <p>
            <strong>Type:</strong> {selectedObject.type}
          </p>
          <p>
            <strong>Room:</strong> {selectedObject.room}
          </p>
          <p>
            <strong>Status:</strong> {selectedObject.status}
          </p>
          <p>
            <strong>OBJ URL:</strong> {selectedObject.objUrl}
          </p>

          <hr />

          <h4 style={{ marginBottom: 8 }}>Live MQTT Data</h4>
          {liveData ? (
            <>
              <p>
                <strong>Light:</strong> {liveData.light}
              </p>
              <p>
                <strong>Temp:</strong> {liveData.temp}
              </p>
              <p>
                <strong>Motion:</strong> {liveData.motion}
              </p>
              <p>
                <strong>Live Status:</strong> {liveData.status || "-"}
              </p>
              <p>
                <strong>Updated:</strong> {liveData.updatedAt || "-"}
              </p>
            </>
          ) : (
            <p>No live data for this object.</p>
          )}
        </>
      )}
    </div>
  );
}
