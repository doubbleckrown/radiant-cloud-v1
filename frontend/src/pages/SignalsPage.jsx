/**
 * SignalsPage
 * ══════════════════════════════════════════════════════════════
 * Changes from previous version:
 *   • Push Notification Permission Card — shown until subscribed
 *   • 95%+ confidence detection from WebSocket SIGNAL messages →
 *     fires a local foreground notification AND vibrates the device
 *   • All other styling/layout preserved exactly
 *
 * Font: Inter (UI)  ·  JetBrains Mono (price/numeric values)
 */
import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence }       from "framer-motion";
import { useWebSocket }                  from "../hooks/useWebSocket";
import { usePushNotifications }          from "../hooks/usePushNotifications";
import { showLocalNotification }         from "../services/pushNotifications";
import api                               from "../utils/api";

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

// Confidence threshold for push notifications
const PUSH_THRESHOLD = 95;

// ═════════════════════════════════════════════════════════════════════════════
export default function SignalsPage() {
  const [signals, setSignals] = useState([]);
  const { lastMessage }       = useWebSocket();
  const push                  = usePushNotifications();

  // Tracks which signal IDs we've already notified for (prevents duplicates)
  const notifiedRef = useRef(new Set());

  // ── Load historic signals on mount ────────────────────────────────────────
  useEffect(() => {
    api.get("/signals").then(({ data }) => setSignals(data)).catch(() => {});
  }, []);

  // ── Handle live WebSocket messages ───────────────────────────────────────
  useEffect(() => {
    if (!lastMessage) return;

    if (lastMessage.type === "SIGNAL") {
      const sig = lastMessage;

      // Prepend to feed
      setSignals(prev => [sig, ...prev].slice(0, 100));

      // ── Push / local notification for 95%+ confidence ──────────────────
      const confidence = sig.confidence ?? 0;
      const sigKey     = `${sig.instrument}-${sig.timestamp}`;

      if (confidence >= PUSH_THRESHOLD && !notifiedRef.current.has(sigKey)) {
        notifiedRef.current.add(sigKey);

        const ins       = (sig.instrument ?? "").replace("_", "/");
        const dir       = sig.direction === "LONG" ? "Long" : "Short";
        const entry     = sig.entry?.toFixed(5) ?? "—";
        const title     = `🚨 High Probability Setup: ${ins} ${dir}`;
        const body      = `Entry at ${entry}  ·  ${confidence}% confluence`;

        // Foreground: local notification via service worker / Notification API
        showLocalNotification(title, body, {
          instrument: sig.instrument,
          direction:  sig.direction,
          entry:      sig.entry,
          confidence,
        });

        // Haptic feedback (supported on mobile Chrome / Safari)
        if (navigator.vibrate) {
          navigator.vibrate([200, 100, 200]);
        }
      }
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
            <h1 style={{ color: C.white, fontSize: "1.2rem", fontWeight: 700, letterSpacing: "0.03em", margin: 0, fontFamily: FONT_UI }}>
              Signals
            </h1>
            <p style={{ color: C.label, fontSize: "0.7rem", margin: "2px 0 0", fontFamily: FONT_UI }}>
              100% confluence · SMC/ICT confirmed
            </p>
          </div>
          {signals.length > 0 && (
            <div style={{
              padding:       "4px 10px",
              borderRadius:  99,
              background:    C.greenDim,
              border:        `1px solid ${C.greenBdr}`,
              color:         C.green,
              fontSize:      "0.65rem",
              fontWeight:    700,
              fontFamily:    FONT_MONO,
              letterSpacing: "0.08em",
            }}>
              {signals.length}
            </div>
          )}
        </div>
      </div>

      {/* ── Content ───────────────────────────────────────────────────────── */}
      <div style={{ padding: "12px 16px 32px", display: "flex", flexDirection: "column", gap: 10 }}>

        {/* ── Push Permission Card ──────────────────────────────────────── */}
        <PushPermissionCard push={push} />

        {/* ── Empty state ──────────────────────────────────────────────── */}
        {signals.length === 0 && (
          <div style={{
            display:        "flex",
            flexDirection:  "column",
            alignItems:     "center",
            justifyContent: "center",
            padding:        "64px 0",
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
              <p style={{ color: C.label, fontSize: "0.82rem", letterSpacing: "0.06em", textTransform: "uppercase", margin: "0 0 4px", fontFamily: FONT_UI }}>
                Awaiting confluence
              </p>
              <p style={{ color: C.sub, fontSize: "0.7rem", margin: 0, fontFamily: FONT_UI }}>
                Signals fire when all 3 SMC layers align
              </p>
            </div>
          </div>
        )}

        {/* ── Signal cards ─────────────────────────────────────────────── */}
        <AnimatePresence>
          {signals.map((sig, i) => {
            const isLong   = sig.direction === "LONG";
            const dirColor = isLong ? C.green : C.red;
            const isHighConf = (sig.confidence ?? 0) >= PUSH_THRESHOLD;
            const ts = sig.timestamp
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
                  {/* ── Header ──────────────────────────────────────────── */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ color: C.white, fontSize: "1rem", fontWeight: 700, letterSpacing: "0.02em", fontFamily: FONT_UI }}>
                        {(sig.instrument ?? "").replace("_", "/")}
                      </span>

                      {/* Direction badge */}
                      <span style={{
                        padding:       "2px 8px",
                        borderRadius:  6,
                        fontSize:      "0.62rem",
                        fontWeight:    700,
                        letterSpacing: "0.07em",
                        color:         dirColor,
                        background:    isLong ? "rgba(0,255,65,0.12)" : "rgba(255,58,58,0.12)",
                        border:        `1px solid ${isLong ? C.greenBdr : "rgba(255,58,58,0.3)"}`,
                        fontFamily:    FONT_UI,
                      }}>
                        {isLong ? "▲ LONG" : "▼ SHORT"}
                      </span>

                      {/* 🚨 High-confidence badge */}
                      {isHighConf && (
                        <motion.span
                          animate={{ opacity: [1, 0.5, 1] }}
                          transition={{ duration: 1.2, repeat: Infinity }}
                          style={{
                            padding:       "2px 7px",
                            borderRadius:  6,
                            fontSize:      "0.58rem",
                            fontWeight:    700,
                            letterSpacing: "0.06em",
                            color:         C.amber,
                            background:    "rgba(255,184,0,0.1)",
                            border:        "1px solid rgba(255,184,0,0.3)",
                            fontFamily:    FONT_UI,
                          }}
                        >
                          🚨 {sig.confidence}%
                        </motion.span>
                      )}
                    </div>

                    <span style={{ color: C.sub, fontSize: "0.68rem", letterSpacing: "0.04em", fontFamily: FONT_MONO }}>
                      {ts}
                    </span>
                  </div>

                  {/* ── Price grid: Entry / SL / TP ─────────────────────── */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
                    {[
                      { label: "Entry",       value: sig.entry?.toFixed(5), color: C.white  },
                      { label: "Stop Loss",   value: sig.sl?.toFixed(5),    color: C.red    },
                      { label: "Take Profit", value: sig.tp?.toFixed(5),    color: C.green  },
                    ].map(({ label, value, color }) => (
                      <div key={label} style={{
                        padding:      "8px 6px",
                        borderRadius: 10,
                        textAlign:    "center",
                        background:   C.sheet,
                        border:       `1px solid ${C.cardBdr}`,
                      }}>
                        <p style={{ color: C.sub, fontSize: "0.58rem", letterSpacing: "0.1em", margin: "0 0 4px", textTransform: "uppercase", fontFamily: FONT_UI }}>
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

                  {/* ── SMC layer breakdown ──────────────────────────────── */}
                  <div style={{
                    padding:       "10px 12px",
                    borderRadius:  10,
                    background:    "rgba(0,0,0,0.4)",
                    border:        `1px solid ${C.cardBdr}`,
                    fontFamily:    FONT_MONO,
                    fontSize:      "0.7rem",
                    display:       "flex",
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


// ─────────────────────────────────────────────────────────────────────────────
//  PushPermissionCard
//  Shown until the user subscribes. Dismissed automatically once subscribed.
//  Hides itself (with animation) if push is not supported in this browser.
// ─────────────────────────────────────────────────────────────────────────────
function PushPermissionCard({ push }) {
  const { supported, permission, subscribed, loading, error, subscribe } = push;

  // Nothing to show if: unsupported, already granted+subscribed, or explicitly denied
  if (!supported)   return null;
  if (subscribed)   return null;
  if (permission === "denied") return <PushDeniedHint />;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1,  y: 0  }}
        exit={{ opacity: 0, height: 0 }}
        transition={{ duration: 0.25 }}
        style={{
          borderRadius: 16,
          overflow:     "hidden",
          background:   C.card,
          border:       "1px solid rgba(255,184,0,0.22)",
          boxShadow:    "0 0 20px rgba(255,184,0,0.06)",
        }}
      >
        {/* Amber top bar */}
        <div style={{
          height:     2,
          background: "linear-gradient(90deg, transparent, #FFB800, transparent)",
        }} />

        <div style={{ padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>

            {/* Icon */}
            <div style={{
              width:          44,
              height:         44,
              borderRadius:   12,
              display:        "flex",
              alignItems:     "center",
              justifyContent: "center",
              fontSize:       "1.3rem",
              flexShrink:     0,
              background:     "rgba(255,184,0,0.08)",
              border:         "1px solid rgba(255,184,0,0.2)",
            }}>
              🔔
            </div>

            {/* Text */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ color: C.white, fontSize: "0.88rem", fontWeight: 700, margin: "0 0 4px", fontFamily: FONT_UI }}>
                Enable Signal Alerts
              </p>
              <p style={{ color: C.label, fontSize: "0.72rem", lineHeight: 1.5, margin: 0, fontFamily: FONT_UI }}>
                Get instant push notifications when the SMC Engine detects a {PUSH_THRESHOLD}%+ confluence setup — even when your screen is off.
              </p>

              {/* Error message */}
              {error && (
                <p style={{ color: C.red, fontSize: "0.68rem", margin: "8px 0 0", fontFamily: FONT_UI }}>
                  ✕ {error}
                </p>
              )}

              {/* CTA button */}
              <motion.button
                whileTap={{ scale: 0.97 }}
                onClick={subscribe}
                disabled={loading}
                style={{
                  marginTop:     12,
                  padding:       "8px 20px",
                  borderRadius:  10,
                  background:    loading ? "rgba(255,184,0,0.08)" : "rgba(255,184,0,0.14)",
                  border:        "1px solid rgba(255,184,0,0.35)",
                  color:         C.amber,
                  fontSize:      "0.75rem",
                  fontWeight:    700,
                  letterSpacing: "0.07em",
                  fontFamily:    FONT_UI,
                  cursor:        loading ? "not-allowed" : "pointer",
                  opacity:       loading ? 0.7 : 1,
                  display:       "flex",
                  alignItems:    "center",
                  gap:           8,
                }}
              >
                {loading ? (
                  <>
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{ duration: 0.7, repeat: Infinity, ease: "linear" }}
                      style={{
                        width: 12, height: 12, borderRadius: "50%",
                        border: "2px solid transparent", borderTopColor: C.amber,
                      }}
                    />
                    Subscribing…
                  </>
                ) : (
                  "Enable Alerts"
                )}
              </motion.button>
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}


// Small inline hint when the user has blocked notifications
function PushDeniedHint() {
  return (
    <div style={{
      padding:      "10px 14px",
      borderRadius: 12,
      background:   "rgba(255,58,58,0.06)",
      border:       "1px solid rgba(255,58,58,0.18)",
      fontSize:     "0.7rem",
      color:        C.label,
      fontFamily:   FONT_UI,
      lineHeight:   1.5,
    }}>
      🔕 Notifications are blocked. To enable alerts, go to your browser / OS settings and allow notifications for this site.
    </div>
  );
}