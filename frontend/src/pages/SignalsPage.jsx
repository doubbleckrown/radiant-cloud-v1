/**
 * SignalsPage — Dual-Engine
 * ══════════════════════════════════════════════════════════════
 * FOREX mode  → Oanda SMC signals via WebSocket + REST /signals
 * CRYPTO mode → Bybit SMC signals via REST polling /bybit/signals
 *
 * Architecture rules:
 *  • `signals`       (FOREX) is NEVER modified in CRYPTO mode
 *  • `cryptoSignals` (BYBIT) is NEVER modified in FOREX mode
 *  • fetchBybitSignals() and the Oanda WebSocket handler are fully isolated
 *  • All BYBIT requests pass X-App-Mode: CRYPTO header
 *  • Push notifications auto-subscribe on mount (no button needed)
 *  • 95%+ confidence signals trigger local notification + haptic feedback
 *    in BOTH modes
 *
 * Font: Inter (UI)  ·  JetBrains Mono (price/numeric values)
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence }                   from "framer-motion";
import { useWebSocket }                              from "../hooks/useWebSocket";
import { usePushNotifications }                      from "../hooks/usePushNotifications";
import { showLocalNotification }                     from "../services/pushNotifications";
import { useTheme }                                  from "../hooks/useTheme";
import api                                           from "../utils/api";

// ── Non-accent design tokens (same across both modes) ─────────────────────────
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

// Confidence threshold for push notifications (both modes)
const PUSH_THRESHOLD = 95;

// ── Normalize Bybit signal → shared schema ─────────────────────────────────────
// Bybit signals may use `symbol` instead of `instrument`; this maps to a common
// shape so the signal card component renders identically in both modes.
function normalizeSig(s) {
  if (!s || typeof s !== "object") return null;
  return {
    ...s,
    // instrument: always present, normalized to display form "BTC/USDT"
    instrument: typeof s.instrument === "string"
      ? s.instrument
      : typeof s.symbol === "string"
      ? s.symbol.replace(/USDT$/, "/USDT").replace(/USDC$/, "/USDC")
      : "—",
  };
}

// ═════════════════════════════════════════════════════════════════════════════
export default function SignalsPage() {
  const { isCrypto, accent, accentDim, accentBdr } = useTheme();

  // ── OANDA engine state (never mutated in CRYPTO mode) ─────────────────────
  const [signals,       setSignals]       = useState([]);

  // ── BYBIT engine state (never mutated in FOREX mode) ──────────────────────
  const [cryptoSignals, setCryptoSignals] = useState([]);

  const { lastMessage } = useWebSocket();
  usePushNotifications();   // auto-subscribes on mount — no manual action needed

  // Tracks which signal IDs we've already notified for (prevents duplicates)
  const notifiedRef = useRef(new Set());

  // ── OANDA: load historic signals on mount ─────────────────────────────────
  useEffect(() => {
    api.get("/signals", { headers: { "X-App-Mode": "FOREX" } })
      .then(({ data }) => setSignals(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []); // eslint-disable-line

  // ── OANDA: handle live WebSocket messages (FOREX only) ────────────────────
  useEffect(() => {
    if (isCrypto || !lastMessage) return;  // ← isolated: never runs in CRYPTO mode

    if (lastMessage.type === "SIGNAL") {
      const sig = normalizeSig(lastMessage) ?? lastMessage;
      setSignals(prev => [sig, ...prev].slice(0, 100));
      fireNotification(sig, notifiedRef);
    }
  }, [lastMessage, isCrypto]);

  // ── BYBIT: poll /bybit/signals (CRYPTO only) ──────────────────────────────
  const fetchBybitSignals = useCallback(async () => {
    try {
      const { data } = await api.get("/bybit/signals", {
        headers: { "X-App-Mode": "CRYPTO" },
      });
      if (!Array.isArray(data)) return;
      const normalized = data.map(normalizeSig).filter(Boolean);
      setCryptoSignals(normalized.slice(0, 100));

      // Notify on any new high-confidence signal that just arrived
      normalized.forEach(sig => {
        if ((sig.confidence ?? 0) >= PUSH_THRESHOLD) {
          fireNotification(sig, notifiedRef);
        }
      });
    } catch {
      // Non-fatal — keep showing stale signals
    }
  }, []);

  useEffect(() => {
    if (!isCrypto) return;  // ← isolated: never runs in FOREX mode
    fetchBybitSignals();
    const id = setInterval(fetchBybitSignals, 30_000);
    return () => clearInterval(id);
  }, [isCrypto, fetchBybitSignals]);

  // ── Active signal feed ─────────────────────────────────────────────────────
  const activeSignals = isCrypto ? cryptoSignals : signals;

  return (
    <div style={{ fontFamily: FONT_UI, color: C.white, minHeight: "100%" }}>

      {/* ── Sticky header ─────────────────────────────────────────────────── */}
      <div style={{
        position:             "sticky",
        top:                  0,
        zIndex:               20,
        padding:              "16px 16px 12px",
        background:           "rgba(5,5,5,0.97)",
        backdropFilter:       "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderBottom:         `1px solid ${accent}14`,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1 style={{
              color: C.white, fontSize: "1.2rem", fontWeight: 700,
              letterSpacing: "0.03em", margin: 0, fontFamily: FONT_UI,
            }}>
              {isCrypto ? "Crypto Signals" : "Signals"}
            </h1>
            <p style={{ color: C.label, fontSize: "0.7rem", margin: "2px 0 0", fontFamily: FONT_UI }}>
              {isCrypto
                ? "100% confluence · Bybit SMC/ICT"
                : "100% confluence · SMC/ICT confirmed"}
            </p>
          </div>
          {activeSignals.length > 0 && (
            <div style={{
              padding:       "4px 10px",
              borderRadius:  99,
              background:    accentDim,
              border:        `1px solid ${accentBdr}`,
              color:         accent,
              fontSize:      "0.65rem",
              fontWeight:    700,
              fontFamily:    FONT_MONO,
              letterSpacing: "0.08em",
            }}>
              {activeSignals.length}
            </div>
          )}
        </div>
      </div>

      {/* ── Content ───────────────────────────────────────────────────────── */}
      <div style={{ padding: "12px 16px 32px", display: "flex", flexDirection: "column", gap: 10 }}>

        {/* ── Empty state ──────────────────────────────────────────────────── */}
        {activeSignals.length === 0 && (
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
                background:     accentDim,
                border:         `1px solid ${accentBdr}`,
                display:        "flex",
                alignItems:     "center",
                justifyContent: "center",
                fontSize:       "1.5rem",
              }}
            >{isCrypto ? "₿" : "⚡"}</motion.div>
            <div style={{ textAlign: "center" }}>
              <p style={{
                color: C.label, fontSize: "0.82rem", letterSpacing: "0.06em",
                textTransform: "uppercase", margin: "0 0 4px", fontFamily: FONT_UI,
              }}>
                Awaiting confluence
              </p>
              <p style={{ color: C.sub, fontSize: "0.7rem", margin: 0, fontFamily: FONT_UI }}>
                {isCrypto
                  ? "Signals fire when all 3 Bybit SMC layers align"
                  : "Signals fire when all 3 SMC layers align"}
              </p>
            </div>
          </div>
        )}

        {/* ── Signal cards ─────────────────────────────────────────────────── */}
        <AnimatePresence>
          {activeSignals.map((sig, i) => (
            <SignalCard key={`${sig.instrument}-${sig.timestamp}-${i}`} sig={sig} accent={accent} />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
//  SignalCard — renders one signal in both FOREX and CRYPTO mode.
//  Both modes share this identical card since normalizeSig() maps Bybit
//  symbols to the same `sig.instrument` field.  The SMC layer breakdown
//  panel is shown only when layer data is present (may be absent on Bybit).
// ─────────────────────────────────────────────────────────────────────────────
function SignalCard({ sig, accent }) {
  const isLong     = sig.direction === "LONG";
  const dirColor   = isLong ? C.green : C.red;
  const isHighConf = (sig.confidence ?? 0) >= PUSH_THRESHOLD;
  const ts         = sig.timestamp
    ? new Date(sig.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "—";

  // Determine price precision from entry magnitude
  const entry = sig.entry ?? null;
  const dec   = entry !== null
    ? (entry > 10000 ? 1 : entry > 100 ? 2 : entry > 1 ? 4 : 5)
    : 5;
  const fmtPrice = (n) => (n != null ? Number(n).toFixed(dec) : "—");

  // Only show layer breakdown if backend provided it
  const hasLayers = sig.layer1 != null || sig.rr != null;

  return (
    <motion.div
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
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              color: C.white, fontSize: "1rem", fontWeight: 700,
              letterSpacing: "0.02em", fontFamily: FONT_UI,
            }}>
              {sig.instrument ?? "—"}
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

          <span style={{
            color: C.sub, fontSize: "0.68rem",
            letterSpacing: "0.04em", fontFamily: FONT_MONO,
          }}>
            {ts}
          </span>
        </div>

        {/* ── Price grid: Entry / SL / TP ─────────────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: hasLayers ? 10 : 0 }}>
          {[
            { label: "Entry",       value: fmtPrice(sig.entry), color: C.white },
            { label: "Stop Loss",   value: fmtPrice(sig.sl),    color: C.red   },
            { label: "Take Profit", value: fmtPrice(sig.tp),    color: C.green },
          ].map(({ label, value, color }) => (
            <div key={label} style={{
              padding:      "8px 6px",
              borderRadius: 10,
              textAlign:    "center",
              background:   C.sheet,
              border:       `1px solid ${C.cardBdr}`,
            }}>
              <p style={{
                color: C.sub, fontSize: "0.58rem", letterSpacing: "0.1em",
                margin: "0 0 4px", textTransform: "uppercase", fontFamily: FONT_UI,
              }}>
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
                {value}
              </p>
            </div>
          ))}
        </div>

        {/* ── SMC / layer breakdown — only shown when backend provides layer data ── */}
        {hasLayers && (
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
            {sig.layer1 != null && (
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: C.sub }}>L1 Trend</span>
                <span style={{
                  color: sig.layer1 === "BULLISH" ? C.green : sig.layer1 === "BEARISH" ? C.red : C.label,
                }}>
                  {sig.layer1}
                </span>
              </div>
            )}
            {sig.layer2 != null && (
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: C.sub }}>L2 Zone</span>
                <span style={{ color: C.label }}>{sig.layer2}</span>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: C.sub }}>L3 MSS</span>
              <span style={{ color: C.green }}>CONFIRMED ✓</span>
            </div>
            {sig.rr != null && (
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: C.sub }}>R:R</span>
                <span style={{ color: C.amber }}>1 : {sig.rr}</span>
              </div>
            )}
            {sig.breakeven != null && (
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: C.sub }}>Breakeven</span>
                <span style={{ color: C.label }}>{fmtPrice(sig.breakeven)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
//  fireNotification — shared across FOREX and CRYPTO signal pipelines.
//  Deduplicates using the notifiedRef Set to prevent double-firing.
// ─────────────────────────────────────────────────────────────────────────────
function fireNotification(sig, notifiedRef) {
  const confidence = sig.confidence ?? 0;
  const sigKey     = `${sig.instrument}-${sig.timestamp}`;

  if (confidence >= PUSH_THRESHOLD && !notifiedRef.current.has(sigKey)) {
    notifiedRef.current.add(sigKey);

    const ins   = sig.instrument ?? "—";
    const dir   = sig.direction === "LONG" ? "Long" : "Short";
    const entry = sig.entry != null ? Number(sig.entry).toFixed(5) : "—";
    const title = `🚨 High Probability Setup: ${ins} ${dir}`;
    const body  = `Entry at ${entry}  ·  ${confidence}% confluence`;

    showLocalNotification(title, body, {
      instrument: sig.instrument,
      direction:  sig.direction,
      entry:      sig.entry,
      confidence,
    });

    if (navigator.vibrate) {
      navigator.vibrate([200, 100, 200]);
    }
  }
}