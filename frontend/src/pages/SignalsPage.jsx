/**
 * SignalsPage — Mode-Aware Signal Feed
 * ══════════════════════════════════════════════════════════════════════════════
 * FOREX mode  → Oanda SMC signals from GET /api/signals
 * CRYPTO mode → Bybit SMC signals from GET /api/bybit/signals
 *               + BybitAutoTrade toggle at the top of the page
 *
 * Signal deduplication:
 *   The backend's TradeTracker ensures only the FIRST signal per instrument
 *   appears until the trade is closed or the 2-hour TTL expires.
 *   The frontend additionally de-dupes by (instrument + direction + timestamp
 *   rounded to 5-minute bucket) so rapid re-fetches don't show duplicates.
 *
 * OneSignal push notifications are initialised automatically on login (in
 * App.jsx) — no toggle shown here.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence }                   from "framer-motion";
import { useAuthStore }                              from "../store/authStore";
import { useTheme }                                  from "../hooks/useTheme";
import api                                           from "../utils/api";

// ── Colour tokens ─────────────────────────────────────────────────────────────
const C = {
  white:   "#ffffff",
  label:   "#aaaaaa",
  sub:     "#555555",
  card:    "#0f0f0f",
  cardBdr: "rgba(255,255,255,0.07)",
  green:   "#00FF41",
  red:     "#FF3B3B",
  amber:   "#FFB800",
};
const FONT_UI   = "'Inter', sans-serif";
const FONT_MONO = "'JetBrains Mono', monospace";

// Interval between signal polls in milliseconds
const POLL_INTERVAL = 15_000;

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────
function fmtPrice(n, decimals = 5) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toFixed(decimals);
}
function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtDate(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" });
}
/** Bucket timestamp to 5-minute window for dedup key */
function dedupeKey(sig) {
  const bucket = Math.floor((sig.timestamp || 0) / 300);
  return `${sig.instrument ?? sig.symbol}|${sig.direction}|${bucket}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main component
// ─────────────────────────────────────────────────────────────────────────────
export default function SignalsPage() {
  const { isCrypto, accent, accentDim, accentBdr } = useTheme();
  const {
    bybit_auto_trade,
    bybit_leverage,
    bybit_margin_type,
  } = useAuthStore();

  const [signals,      setSignals]      = useState([]);
  const [tradeLocks,   setTradeLocks]   = useState({});
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState(null);
  const [autoTradeOn,  setAutoTradeOn]  = useState(bybit_auto_trade ?? false);
  const [togglingAT,   setTogglingAT]   = useState(false);
  const seenKeys = useRef(new Set());

  // ── Fetch signals ─────────────────────────────────────────────────────────
  const fetchSignals = useCallback(async () => {
    try {
      const endpoint = isCrypto ? "/bybit/signals" : "/signals";
      const { data } = await api.get(endpoint);
      // De-dupe: keep only first signal per instrument bucket
      const deduped = [];
      const seen    = new Set();
      for (const sig of (data ?? [])) {
        const key = dedupeKey(sig);
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(sig);
        }
      }
      setSignals(deduped);
      setError(null);
    } catch (e) {
      setError(e?.userMessage ?? "Could not load signals");
    } finally {
      setLoading(false);
    }
  }, [isCrypto]);

  // ── Fetch trade locks (Bybit only) ────────────────────────────────────────
  const fetchTradeLocks = useCallback(async () => {
    if (!isCrypto) { setTradeLocks({}); return; }
    try {
      const { data } = await api.get("/bybit/trade-locks");
      setTradeLocks(data ?? {});
    } catch { /* non-critical */ }
  }, [isCrypto]);

  // ── Poll on mount + interval ──────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    setSignals([]);
    seenKeys.current.clear();
    fetchSignals();
    fetchTradeLocks();
    const id = setInterval(() => { fetchSignals(); fetchTradeLocks(); }, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchSignals, fetchTradeLocks]);

  // Sync toggle state when authStore hydrates
  useEffect(() => {
    setAutoTradeOn(bybit_auto_trade ?? false);
  }, [bybit_auto_trade]);

  // ── Toggle Bybit AutoTrade ────────────────────────────────────────────────
  const handleAutoTradeToggle = useCallback(async () => {
    const next = !autoTradeOn;
    setAutoTradeOn(next);
    setTogglingAT(true);
    try {
      await api.patch("/bybit/settings", { bybit_auto_trade: next });
      // Optimistically sync into authStore (no full refresh needed)
      const store = useAuthStore.getState();
      if (typeof store.setBybitSettings === "function") {
        store.setBybitSettings({ bybit_auto_trade: next });
      }
    } catch (e) {
      setAutoTradeOn(!next); // revert on failure
    } finally {
      setTogglingAT(false);
    }
  }, [autoTradeOn]);

  return (
    <div style={{ fontFamily: FONT_UI, color: C.white, minHeight: "100%" }}>

      {/* ── Sticky header ────────────────────────────────────────────────── */}
      <div style={{
        position:             "sticky",
        top:                  0,
        zIndex:               20,
        padding:              "16px 16px 12px",
        background:           "rgba(5,5,5,0.97)",
        backdropFilter:       "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderBottom:         `1px solid ${accent}14`,
        transition:           "border-color 0.4s ease",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1 style={{
              color: C.white, fontSize: "1.2rem", fontWeight: 700,
              letterSpacing: "0.03em", margin: "0 0 2px",
            }}>
              Signals
            </h1>
            <p style={{ color: C.sub, fontSize: "0.65rem", margin: 0, fontFamily: FONT_MONO }}>
              {isCrypto ? "Bybit Linear · SMC 1:3 RR" : "Oanda v20 · SMC 1:2 RR"} · auto-refresh 15s
            </p>
          </div>

          {/* Signal count badge */}
          {signals.length > 0 && (
            <motion.div
              initial={{ scale: 0.7, opacity: 0 }}
              animate={{ scale: 1,   opacity: 1 }}
              style={{
                padding:       "4px 10px",
                borderRadius:  99,
                background:    accentDim,
                border:        `1px solid ${accentBdr}`,
                color:         accent,
                fontSize:      "0.65rem",
                fontWeight:    700,
                fontFamily:    FONT_MONO,
                letterSpacing: "0.06em",
              }}
            >
              {signals.length} ACTIVE
            </motion.div>
          )}
        </div>
      </div>

      <div style={{ padding: "16px 16px 40px", display: "flex", flexDirection: "column", gap: 12 }}>

        {/* ── Bybit AutoTrade Toggle (CRYPTO mode only) ──────────────────── */}
        <AnimatePresence>
          {isCrypto && (
            <motion.div
              key="bybit-autotrade"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25 }}
              style={{ overflow: "hidden" }}
            >
              <BybitAutoTradeCard
                enabled={autoTradeOn}
                toggling={togglingAT}
                leverage={bybit_leverage ?? 20}
                marginType={bybit_margin_type ?? "ISOLATED"}
                onToggle={handleAutoTradeToggle}
                accent={accent}
                accentDim={accentDim}
                accentBdr={accentBdr}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Loading skeleton ────────────────────────────────────────────── */}
        {loading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[1, 2, 3].map(i => (
              <div key={i} style={{
                height: 120, borderRadius: 16,
                background: "rgba(255,255,255,0.03)",
                border: `1px solid ${C.cardBdr}`,
                animation: "pulse 1.8s ease-in-out infinite",
              }} />
            ))}
          </div>
        )}

        {/* ── Error state ─────────────────────────────────────────────────── */}
        {!loading && error && (
          <div style={{
            padding: "16px", borderRadius: 14,
            background: "rgba(255,59,59,0.07)", border: "1px solid rgba(255,59,59,0.22)",
            color: C.red, fontSize: "0.8rem", textAlign: "center",
          }}>
            ⚠ {error}
            <button
              onClick={fetchSignals}
              style={{
                display: "block", margin: "10px auto 0", padding: "6px 14px",
                borderRadius: 8, background: "rgba(255,59,59,0.1)",
                border: "1px solid rgba(255,59,59,0.3)",
                color: C.red, fontSize: "0.72rem", cursor: "pointer",
              }}
            >Retry</button>
          </div>
        )}

        {/* ── Empty state ─────────────────────────────────────────────────── */}
        {!loading && !error && signals.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            style={{ textAlign: "center", paddingTop: 48 }}
          >
            <div style={{ fontSize: "2.4rem", marginBottom: 12 }}>
              {isCrypto ? "₿" : "📡"}
            </div>
            <p style={{ color: C.label, fontSize: "0.88rem", fontWeight: 600, margin: "0 0 6px" }}>
              Scanning for setups…
            </p>
            <p style={{ color: C.sub, fontSize: "0.72rem", margin: 0 }}>
              The SMC engine requires all 3 layers to confirm before firing a signal.
            </p>
          </motion.div>
        )}

        {/* ── Signal cards ────────────────────────────────────────────────── */}
        <AnimatePresence initial={false}>
          {signals.map((sig, idx) => {
            const sym    = sig.instrument ?? sig.symbol ?? "";
            const locked = isCrypto && Boolean(tradeLocks[sym]);
            return (
              <motion.div
                key={`${sym}${sig.direction}${sig.timestamp}`}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.25, delay: idx * 0.04 }}
              >
                <SignalCard
                  sig={sig}
                  locked={locked}
                  isCrypto={isCrypto}
                  accent={accent}
                  accentDim={accentDim}
                  accentBdr={accentBdr}
                />
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {/* Pulse keyframe */}
      <style>{`@keyframes pulse{0%,100%{opacity:.5}50%{opacity:1}}`}</style>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  BybitAutoTradeCard
//  Prominent toggle shown at top of Signals page in CRYPTO mode.
//  When ON: the backend will auto-execute every 100% confidence signal
//           for this user using their saved Bybit credentials.
// ─────────────────────────────────────────────────────────────────────────────
function BybitAutoTradeCard({ enabled, toggling, leverage, marginType, onToggle, accent, accentDim, accentBdr }) {
  const BYBIT_ORANGE = "#FFA500";
  const clr = enabled ? BYBIT_ORANGE : C.sub;

  return (
    <motion.div
      animate={{
        background: enabled ? "rgba(255,165,0,0.06)" : C.card,
        border:     `1px solid ${enabled ? "rgba(255,165,0,0.28)" : C.cardBdr}`,
        boxShadow:  enabled ? "0 0 28px rgba(255,165,0,0.12)" : "none",
      }}
      transition={{ duration: 0.35 }}
      style={{ borderRadius: 18, overflow: "hidden" }}
    >
      {/* Main toggle row */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "16px 16px" }}>
        {/* Icon */}
        <motion.div
          animate={{
            background: enabled ? "rgba(255,165,0,0.15)" : "rgba(255,255,255,0.04)",
            border:     `1px solid ${enabled ? "rgba(255,165,0,0.4)" : C.cardBdr}`,
            boxShadow:  enabled ? "0 0 16px rgba(255,165,0,0.25)" : "none",
          }}
          transition={{ duration: 0.35 }}
          style={{
            width: 48, height: 48, borderRadius: 14, flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "1.5rem",
          }}
        >
          {enabled ? "⚡" : "🤖"}
        </motion.div>

        {/* Text */}
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <p style={{ color: C.white, fontSize: "0.92rem", fontWeight: 700, margin: 0 }}>
              Bybit Auto-Trade
            </p>
            {enabled && (
              <motion.span
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                style={{
                  fontSize: "0.55rem", fontWeight: 800, letterSpacing: "0.1em",
                  padding: "2px 7px", borderRadius: 5,
                  background: "rgba(255,165,0,0.15)",
                  border: "1px solid rgba(255,165,0,0.4)",
                  color: BYBIT_ORANGE, fontFamily: FONT_MONO,
                }}
              >LIVE</motion.span>
            )}
          </div>
          <motion.p
            animate={{ color: clr }}
            transition={{ duration: 0.3 }}
            style={{ fontSize: "0.68rem", margin: "3px 0 0", lineHeight: 1.4 }}
          >
            {enabled
              ? `Auto-executing 100% signals · ${leverage}× ${marginType} · 1:3 RR`
              : "Enable to auto-execute 100% confidence Bybit signals"}
          </motion.p>
        </div>

        {/* Toggle switch */}
        <button
          onClick={onToggle}
          disabled={toggling}
          aria-label={enabled ? "Disable Bybit Auto-Trade" : "Enable Bybit Auto-Trade"}
          style={{
            width: 52, height: 30, borderRadius: 15,
            background:    enabled ? "rgba(255,165,0,0.25)" : "rgba(255,255,255,0.07)",
            border:        `1.5px solid ${enabled ? "rgba(255,165,0,0.5)" : C.cardBdr}`,
            cursor:        toggling ? "not-allowed" : "pointer",
            position:      "relative",
            flexShrink:    0,
            transition:    "background 0.3s, border-color 0.3s",
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <motion.div
            animate={{ x: enabled ? 22 : 2 }}
            transition={{ type: "spring", stiffness: 600, damping: 38 }}
            style={{
              position:  "absolute",
              top:       3, width: 22, height: 22, borderRadius: "50%",
              background: enabled ? BYBIT_ORANGE : "#444",
              boxShadow:  enabled ? `0 0 10px ${BYBIT_ORANGE}60` : "none",
            }}
          />
        </button>
      </div>

      {/* Warning banner when enabled */}
      <AnimatePresence>
        {enabled && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            style={{ overflow: "hidden" }}
          >
            <div style={{
              margin: "0 16px 14px",
              padding: "10px 14px", borderRadius: 10,
              background: "rgba(255,165,0,0.06)",
              border: "1px solid rgba(255,165,0,0.2)",
              display: "flex", gap: 10, alignItems: "flex-start",
            }}>
              <span style={{ fontSize: "1rem", flexShrink: 0 }}>⚠️</span>
              <p style={{ color: "#cc8800", fontSize: "0.68rem", margin: 0, lineHeight: 1.6 }}>
                Real orders will be placed with <strong style={{ color: BYBIT_ORANGE }}>{leverage}× Isolated Margin</strong>.
                Ensure your Bybit credentials are saved in Profile and your account has sufficient margin.
                Risk per trade is set in Profile → Risk Configuration.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  SignalCard
// ─────────────────────────────────────────────────────────────────────────────
function SignalCard({ sig, locked, isCrypto, accent, accentDim, accentBdr }) {
  const [expanded, setExpanded] = useState(false);

  const isLong     = sig.direction === "LONG";
  const dirColor   = isLong ? C.green : C.red;
  const sym        = (sig.instrument ?? sig.symbol ?? "").replace("_", "/");
  const conf       = sig.confidence ?? 0;
  const confColor  = conf >= 100 ? accent : conf >= 80 ? C.amber : C.label;

  // Decimal places: crypto needs 4, forex needs 5
  const dp = isCrypto ? 4 : 5;

  return (
    <motion.div
      layout
      style={{
        borderRadius: 18, overflow: "hidden",
        background:   C.card,
        border:       `1px solid ${locked ? "rgba(255,165,0,0.3)" : C.cardBdr}`,
        opacity:      locked ? 0.72 : 1,
        boxShadow:    conf >= 100 ? `0 0 22px ${accent}1a` : "none",
      }}
    >
      {/* ── Header row ──────────────────────────────────────────────────── */}
      <button
        onClick={() => setExpanded(p => !p)}
        style={{
          width: "100%", background: "transparent", border: "none",
          padding: "14px 16px", cursor: "pointer",
          display: "flex", alignItems: "center", gap: 12, textAlign: "left",
        }}
      >
        {/* Direction dot */}
        <div style={{
          width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
          background: dirColor, boxShadow: `0 0 8px ${dirColor}80`,
        }} />

        {/* Pair + direction */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{
              color: C.white, fontSize: "0.92rem", fontWeight: 700,
              fontFamily: FONT_MONO,
            }}>
              {sym}
            </span>
            <span style={{
              fontSize: "0.58rem", fontWeight: 800, letterSpacing: "0.1em",
              padding: "2px 7px", borderRadius: 5,
              background: `${dirColor}18`, border: `1px solid ${dirColor}40`,
              color: dirColor, fontFamily: FONT_MONO,
            }}>
              {sig.direction}
            </span>
            {locked && (
              <span style={{
                fontSize: "0.55rem", fontWeight: 700, letterSpacing: "0.08em",
                padding: "2px 7px", borderRadius: 5,
                background: "rgba(255,165,0,0.12)", border: "1px solid rgba(255,165,0,0.3)",
                color: "#FFA500", fontFamily: FONT_MONO,
              }}>🔒 LOCKED</span>
            )}
          </div>
          <p style={{ color: C.sub, fontSize: "0.6rem", margin: "3px 0 0", fontFamily: FONT_MONO }}>
            {fmtDate(sig.timestamp)} · {fmtTime(sig.timestamp)}
          </p>
        </div>

        {/* Confidence */}
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <motion.p
            animate={{ color: confColor, textShadow: conf >= 100 ? `0 0 10px ${confColor}` : "none" }}
            transition={{ duration: 0.3 }}
            style={{ fontSize: "1.2rem", fontWeight: 800, fontFamily: FONT_MONO, margin: 0 }}
          >
            {conf}%
          </motion.p>
          <p style={{ color: C.sub, fontSize: "0.55rem", margin: "2px 0 0", letterSpacing: "0.06em" }}>
            CONFLUENCE
          </p>
        </div>

        {/* Expand chevron */}
        <motion.div
          animate={{ rotate: expanded ? 180 : 0 }}
          style={{ color: C.sub, fontSize: "0.7rem", flexShrink: 0 }}
        >▾</motion.div>
      </button>

      {/* ── Price levels (always visible) ───────────────────────────────── */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
        gap: 1, borderTop: `1px solid ${C.cardBdr}`,
      }}>
        {[
          { label: "ENTRY",  value: fmtPrice(sig.entry, dp), color: C.white },
          { label: "SL",     value: fmtPrice(sig.sl,    dp), color: C.red   },
          { label: "TP",     value: fmtPrice(sig.tp,    dp), color: C.green },
        ].map(({ label, value, color }) => (
          <div key={label} style={{
            textAlign: "center", padding: "10px 8px",
            borderRight: `1px solid ${C.cardBdr}`,
          }}>
            <p style={{ color: C.sub, fontSize: "0.52rem", letterSpacing: "0.1em", margin: "0 0 3px", fontFamily: FONT_UI }}>{label}</p>
            <p style={{ color, fontSize: "0.75rem", fontWeight: 600, margin: 0, fontFamily: FONT_MONO }}>{value}</p>
          </div>
        ))}
      </div>

      {/* ── Expanded detail ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22 }}
            style={{ overflow: "hidden" }}
          >
            <div style={{ padding: "14px 16px", borderTop: `1px solid ${C.cardBdr}` }}>

              {/* Layer badges */}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                <LayerBadge label="L1 Trend" active={!!sig.layer1} value={sig.layer1} accent={accent} />
                <LayerBadge label="L2 Zone"  active={!!sig.layer2} value={sig.layer2 ? "OB/FVG" : null} accent={accent} />
                <LayerBadge label="L3 MSS"   active={!!sig.layer3} value={sig.layer3 ? "CHoCH" : null} accent={accent} />
              </div>

              {/* Detail rows */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <DetailRow label="Breakeven" value={fmtPrice(sig.breakeven, dp)} mono />
                <DetailRow label="Risk/Reward" value={`1 : ${sig.rr ?? (isCrypto ? "3.0" : "2.0")}`} mono />
                {isCrypto && (
                  <DetailRow label="Engine" value="Bybit Linear · 20× Isolated" />
                )}
                {locked && (
                  <div style={{
                    marginTop: 4, padding: "8px 12px", borderRadius: 8,
                    background: "rgba(255,165,0,0.07)", border: "1px solid rgba(255,165,0,0.22)",
                    color: "#FFA500", fontSize: "0.68rem",
                  }}>
                    🔒 Trade active for this instrument. New signals suppressed until SL/TP hit or 2h TTL expires.
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Sub-components
// ─────────────────────────────────────────────────────────────────────────────
function LayerBadge({ label, active, value, accent }) {
  return (
    <div style={{
      display:    "flex", alignItems: "center", gap: 5,
      padding:    "4px 10px", borderRadius: 8,
      background: active ? `${accent}12` : "rgba(255,255,255,0.03)",
      border:     `1px solid ${active ? `${accent}35` : C.cardBdr}`,
    }}>
      <div style={{
        width: 6, height: 6, borderRadius: "50%",
        background: active ? accent : C.sub,
        boxShadow:  active ? `0 0 5px ${accent}` : "none",
      }} />
      <span style={{
        color:         active ? accent : C.sub,
        fontSize:      "0.6rem", fontWeight: 700,
        fontFamily:    FONT_MONO, letterSpacing: "0.06em",
      }}>
        {label}{value && active ? `: ${value}` : ""}
      </span>
    </div>
  );
}

function DetailRow({ label, value, mono }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <span style={{ color: C.sub,   fontSize: "0.7rem",  fontFamily: FONT_UI  }}>{label}</span>
      <span style={{ color: C.white, fontSize: "0.72rem", fontFamily: mono ? FONT_MONO : FONT_UI, fontWeight: 500 }}>{value}</span>
    </div>
  );
}