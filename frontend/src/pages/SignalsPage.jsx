/**
 * SignalsPage
 * ══════════════════════════════════════════════════════════════
 * 100%-confluence SMC/ICT signal feed.
 * Fully reskinned to match AccountPage design tokens exactly.
 * Font: Inter (UI)  ·  JetBrains Mono (price/numeric values)
 */
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useWebSocket } from "../hooks/useWebSocket";
import api from "../utils/api";

// ── Design tokens — identical to AccountPage ──────────────────────────────────
const C = {
  green:    "#00FF41",
  greenDim: "rgba(0,255,65,0.12)",
  greenBdr: "rgba(0,255,65,0.25)",
  red:      "#FF3A3A",
  amber:    "#FFB800",
  white:    "#ffffff",
  label:    "#aaaaaa",
  sub:      "#666666",
  card:     "#0f0f0f",
  cardBdr:  "rgba(255,255,255,0.07)",
  sheet:    "#141414",
};

const FONT_UI   = "'Inter', sans-serif";
const FONT_MONO = "'JetBrains Mono', monospace";

// ═════════════════════════════════════════════════════════════════════════════
export default function SignalsPage() {
  const [signals, setSignals] = useState([]);
  const { lastMessage } = useWebSocket();

  useEffect(() => {
    api.get("/signals").then(({ data }) => setSignals(data)).catch(() => {});
  }, []);

  useEffect(() => {
    if (lastMessage?.type === "SIGNAL") {
      setSignals(prev => [lastMessage, ...prev].slice(0, 100));
    }
  }, [lastMessage]);

  return (
    <div style={{ fontFamily: FONT_UI, color: C.white, minHeight: "100%" }}>

      {/* ── Sticky header ─────────────────────────────────────────────────── */}
      <div style={{
        position:       "sticky",
        top:            0,
        zIndex:         20,
        padding:        "16px 16px 12px",
        background:     "rgba(5,5,5,0.97)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderBottom:   "1px solid rgba(0,255,65,0.08)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1 style={{ color: C.white, fontSize: "1.2rem", fontWeight: 700, letterSpacing: "0.03em", margin: 0 }}>
              Signals
            </h1>
            <p style={{ color: C.label, fontSize: "0.7rem", margin: "2px 0 0" }}>
              100% confluence · SMC/ICT confirmed
            </p>
          </div>
          {signals.length > 0 && (
            <div style={{
              padding:    "4px 10px",
              borderRadius: 99,
              background:  C.greenDim,
              border:      `1px solid ${C.greenBdr}`,
              color:       C.green,
              fontSize:    "0.65rem",
              fontWeight:  700,
              fontFamily:  FONT_MONO,
              letterSpacing: "0.08em",
            }}>
              {signals.length}
            </div>
          )}
        </div>
      </div>

      {/* ── Content ───────────────────────────────────────────────────────── */}
      <div style={{ padding: "12px 16px 32px", display: "flex", flexDirection: "column", gap: 10 }}>

        {/* Empty state */}
        {signals.length === 0 && (
          <div style={{
            display:        "flex",
            flexDirection:  "column",
            alignItems:     "center",
            justifyContent: "center",
            padding:        "80px 0",
            gap:            16,
          }}>
            <motion.div
              animate={{ scale: [1, 1.08, 1], opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 2.2, repeat: Infinity }}
              style={{
                width:          60,
                height:         60,
                borderRadius:   "50%",
                background:     C.greenDim,
                border:         `1px solid ${C.greenBdr}`,
                display:        "flex",
                alignItems:     "center",
                justifyContent: "center",
                fontSize:       "1.5rem",
              }}
            >⚡</motion.div>
            <div style={{ textAlign: "center" }}>
              <p style={{ color: C.label, fontSize: "0.82rem", letterSpacing: "0.06em", textTransform: "uppercase", margin: "0 0 4px" }}>
                Awaiting confluence
              </p>
              <p style={{ color: C.sub, fontSize: "0.7rem", margin: 0 }}>
                Signals fire when all 3 SMC layers align
              </p>
            </div>
          </div>
        )}

        {/* Signal cards */}
        <AnimatePresence>
          {signals.map((sig, i) => {
            const isLong   = sig.direction === "LONG";
            const dirColor = isLong ? C.green : C.red;
            const ts       = sig.timestamp
              ? new Date(sig.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : "—";

            return (
              <motion.div
                key={`${sig.instrument}-${sig.timestamp}-${i}`}
                initial={{ opacity: 0, y: -16, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
                style={{
                  borderRadius: 16,
                  overflow:     "hidden",
                  background:   C.card,
                  border:       `1px solid ${isLong ? "rgba(0,255,65,0.22)" : "rgba(255,58,58,0.22)"}`,
                  boxShadow:    isLong
                    ? "0 0 16px rgba(0,255,65,0.06)"
                    : "0 0 16px rgba(255,58,58,0.06)",
                }}
              >
                {/* Direction accent bar */}
                <div style={{
                  height:     2,
                  background: isLong
                    ? "linear-gradient(90deg, transparent, #00FF41, transparent)"
                    : "linear-gradient(90deg, transparent, #FF3A3A, transparent)",
                }} />

                <div style={{ padding: 14 }}>
                  {/* Header */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ color: C.white, fontSize: "1rem", fontWeight: 700, letterSpacing: "0.02em" }}>
                        {(sig.instrument ?? "").replace("_", "/")}
                      </span>
                      <span style={{
                        padding:       "2px 8px",
                        borderRadius:  6,
                        fontSize:      "0.62rem",
                        fontWeight:    700,
                        letterSpacing: "0.07em",
                        color:         dirColor,
                        background:    isLong ? "rgba(0,255,65,0.12)" : "rgba(255,58,58,0.12)",
                        border:        `1px solid ${isLong ? C.greenBdr : "rgba(255,58,58,0.3)"}`,
                      }}>
                        {isLong ? "▲ LONG" : "▼ SHORT"}
                      </span>
                    </div>
                    <span style={{ color: C.sub, fontSize: "0.68rem", letterSpacing: "0.04em", fontFamily: FONT_MONO }}>
                      {ts}
                    </span>
                  </div>

                  {/* Price grid — Entry / SL / TP */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
                    {[
                      { label: "Entry",    value: sig.entry?.toFixed(5),    color: C.white },
                      { label: "Stop Loss", value: sig.sl?.toFixed(5),      color: C.red   },
                      { label: "Take Profit", value: sig.tp?.toFixed(5),    color: C.green },
                    ].map(({ label, value, color }) => (
                      <div key={label} style={{
                        padding:    "8px 6px",
                        borderRadius: 10,
                        textAlign:  "center",
                        background: C.sheet,
                        border:     `1px solid ${C.cardBdr}`,
                      }}>
                        <p style={{ color: C.sub, fontSize: "0.58rem", letterSpacing: "0.1em", margin: "0 0 4px", textTransform: "uppercase" }}>
                          {label}
                        </p>
                        <p style={{
                          color,
                          fontSize:   "0.72rem",
                          fontWeight: 600,
                          fontFamily: FONT_MONO,
                          margin:     0,
                          textShadow: color !== C.white ? `0 0 6px ${color}55` : "none",
                        }}>
                          {value ?? "—"}
                        </p>
                      </div>
                    ))}
                  </div>

                  {/* SMC layer breakdown */}
                  <div style={{
                    padding:      "10px 12px",
                    borderRadius: 10,
                    background:   "rgba(0,0,0,0.4)",
                    border:       `1px solid ${C.cardBdr}`,
                    fontFamily:   FONT_MONO,
                    fontSize:     "0.7rem",
                    display:      "flex",
                    flexDirection: "column",
                    gap:           5,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: C.sub }}>L1 Trend</span>
                      <span style={{ color: sig.layer1 === "BULLISH" ? C.green : sig.layer1 === "BEARISH" ? C.red : C.label }}>
                        {sig.layer1 ?? "—"}
                      </span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: C.sub }}>L2 Zone</span>
                      <span style={{ color: C.label }}>{sig.layer2 ?? "—"}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: C.sub }}>L3 MSS</span>
                      <span style={{ color: C.green }}>CONFIRMED ✓</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: C.sub }}>R:R</span>
                      <span style={{ color: C.amber }}>1 : {sig.rr ?? "?"}</span>
                    </div>
                    {sig.breakeven && (
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ color: C.sub }}>Breakeven</span>
                        <span style={{ color: C.label }}>{sig.breakeven?.toFixed(5)}</span>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}