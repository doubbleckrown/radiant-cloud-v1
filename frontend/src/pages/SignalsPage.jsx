import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useWebSocket } from "../hooks/useWebSocket";
import api from "../utils/api";

export default function SignalsPage() {
  const [signals, setSignals] = useState([]);
  const { lastMessage } = useWebSocket(); // Clerk token fetched internally

  useEffect(() => {
    api.get("/signals").then(({ data }) => setSignals(data)).catch(() => {});
  }, []);

  useEffect(() => {
    if (lastMessage?.type === "SIGNAL") {
      setSignals((prev) => [lastMessage, ...prev].slice(0, 100));
    }
  }, [lastMessage]);

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
      {/* Header */}
      <div
        className="sticky top-0 z-20 px-4 pt-4 pb-3"
        style={{
          background: "rgba(5,5,5,0.95)",
          backdropFilter: "blur(20px)",
          borderBottom: "1px solid rgba(0,255,65,0.06)",
        }}
      >
        <h1 className="text-xl font-display text-white tracking-wide">Signals</h1>
        <p style={{ color: "#aaaaaa", fontSize: "0.72rem", marginTop: 2 }}>100% confluence · SMC/ICT confirmed</p>
      </div>

      <div className="px-4 py-3 space-y-3">
        {signals.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <motion.div
              animate={{ scale: [1, 1.1, 1], opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 2, repeat: Infinity }}
              className="w-16 h-16 rounded-full flex items-center justify-center"
              style={{ background: "rgba(0,255,65,0.06)", border: "1px solid rgba(0,255,65,0.12)" }}
            >
              <span className="text-2xl">⚡</span>
            </motion.div>
            <div className="text-center">
              <p style={{ color: "#aaaaaa", fontSize: "0.875rem", letterSpacing: "0.06em", textTransform: "uppercase" }}>Awaiting confluence</p>
              <p style={{ color: "#777777", fontSize: "0.72rem", marginTop: 4 }}>Signals fire when all 3 SMC layers align</p>
            </div>
          </div>
        )}

        <AnimatePresence>
          {signals.map((sig, i) => (
            <motion.div
              key={`${sig.instrument}-${sig.timestamp}`}
              initial={{ opacity: 0, y: -20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.4, ease: [0.32, 0.72, 0, 1] }}
              className="rounded-2xl overflow-hidden"
              style={{
                background: "#0f0f0f",
                border: `1px solid ${sig.direction === "LONG" ? "rgba(0,255,65,0.2)" : "rgba(255,58,58,0.2)"}`,
                boxShadow: sig.direction === "LONG"
                  ? "0 0 16px rgba(0,255,65,0.06)"
                  : "0 0 16px rgba(255,58,58,0.06)",
              }}
            >
              {/* Top accent bar */}
              <div
                className="h-[2px]"
                style={{
                  background: sig.direction === "LONG"
                    ? "linear-gradient(90deg, transparent, #00FF41, transparent)"
                    : "linear-gradient(90deg, transparent, #FF3A3A, transparent)",
                }}
              />

              <div className="p-4">
                {/* Header row */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-white text-base tracking-wide">
                      {sig.instrument?.replace("_", "/")}
                    </span>
                    <span
                      className="px-2 py-0.5 rounded-lg font-display text-xs tracking-widest uppercase"
                      style={{
                        background: sig.direction === "LONG" ? "rgba(0,255,65,0.12)" : "rgba(255,58,58,0.12)",
                        color:      sig.direction === "LONG" ? "#00FF41" : "#FF3A3A",
                        border:     `1px solid ${sig.direction === "LONG" ? "rgba(0,255,65,0.25)" : "rgba(255,58,58,0.25)"}`,
                      }}
                    >
                      {sig.direction === "LONG" ? "▲ LONG" : "▼ SHORT"}
                    </span>
                  </div>
                  <span style={{ color: "#aaaaaa", fontSize: "0.72rem", letterSpacing: "0.05em" }}>
                    {new Date(sig.timestamp * 1000).toLocaleTimeString()}
                  </span>
                </div>

                {/* Price grid */}
                <div className="grid grid-cols-3 gap-2 mb-3">
                  {[
                    { label: "Entry",  value: sig.entry?.toFixed(5), highlight: true },
                    { label: "SL",     value: sig.sl?.toFixed(5),    color: "#FF3A3A" },
                    { label: "TP",     value: sig.tp?.toFixed(5),    color: "#00FF41" },
                  ].map(({ label, value, highlight, color }) => (
                    <div
                      key={label}
                      className="px-2 py-2 rounded-xl text-center"
                      style={{ background: "#141414", border: "1px solid rgba(255,255,255,0.05)" }}
                    >
                      <div style={{ color: "#aaaaaa", fontSize: "0.6rem", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
                      <div
                        className="font-mono text-xs font-semibold"
                        style={{
                          color:      color ?? "#e0e0e0",
                          fontFamily: "'JetBrains Mono', monospace",
                          textShadow: color ? `0 0 6px ${color}60` : "none",
                        }}
                      >
                        {value ?? "—"}
                      </div>
                    </div>
                  ))}
                </div>

                {/* SMC layer info */}
                <div
                  className="px-3 py-2 rounded-xl font-mono text-xs"
                  style={{
                    color: "#aaaaaa",
                    background: "rgba(0,0,0,0.4)",
                    border: "1px solid rgba(255,255,255,0.04)",
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  <div><span style={{ color: "#777777" }}>L1</span> <span className="text-white">{sig.layer1}</span></div>
                  <div><span style={{ color: "#777777" }}>L2</span> <span className="text-white">{sig.layer2}</span></div>
                  <div><span style={{ color: "#777777" }}>L3</span> <span style={{ color: "#00FF41" }}>MSS CONFIRMED</span></div>
                  <div><span style={{ color: "#777777" }}>RR</span> <span className="text-white">1:{sig.rr}</span></div>
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}