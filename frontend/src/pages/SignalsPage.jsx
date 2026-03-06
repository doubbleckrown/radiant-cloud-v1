/**
 * SignalsPage v3 — Private Bot Mode
 * ══════════════════════════════════════════════════════════════════════════════
 * Architecture:
 *   • NO auto-trade toggle — bot always executes at 100% confluence
 *   • TWO TABS: [Active Signals]  [Signal History]
 *   • Active tab  — signals where instrument is currently trade-locked
 *                   OR signals fired in the last 2 hours (TTL window)
 *   • History tab — all remaining older signals (up to 100 per engine)
 *   • Oanda signals driven by WebSocket + REST fallback
 *   • Bybit signals via REST (no WS — polling every 30 s is efficient enough)
 *   • No auto-refresh interval — WS push for Oanda, 30 s poll for Bybit
 *
 * TradeTracker lock badges are shown on every card that has an active lock.
 * "Bot executed" badge shown on 100% confidence cards.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence }                   from "framer-motion";
import { useAuthStore }                              from "../store/authStore";
import { useAuth }                                     from "@clerk/clerk-react";
import { useTheme }                                  from "../hooks/useTheme";
import { useWebSocket }                              from "../hooks/useWebSocket";
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

// How old (in seconds) a signal can be and still appear in Active tab
const ACTIVE_WINDOW_S = 7200; // 2 hours — matches TradeTracker TTL

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────
function fmtPrice(n, decimals = 5) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toFixed(decimals);
}
function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtDate(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" });
}
function fmtAgo(ts) {
  if (!ts) return "";
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
/** Strict dedup key — instrument + direction only (no time bucket). 
 *  Prevents EUR/GBP double-printing when the same signal is pushed via WS
 *  AND fetched via REST in the same polling cycle. */
function dedupeKey(sig) {
  return `${sig.instrument ?? sig.symbol}|${sig.direction}`;
}
/** True if this signal is "recent" (within active window) */
function isRecent(sig) {
  return (Date.now() / 1000 - (sig.timestamp ?? 0)) < ACTIVE_WINDOW_S;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main component
// ─────────────────────────────────────────────────────────────────────────────
export default function SignalsPage() {
  const { isCrypto, accent, accentDim, accentBdr } = useTheme();
  const { oanda_risk_pct, bybit_risk_pct, fetchProfile } = useAuthStore();
  const { getToken } = useAuth();
  const [activeTab,  setActiveTab]  = useState("Active");
  const [signals,    setSignals]    = useState([]);
  const [tradeLocks, setTradeLocks] = useState({});
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  // Bot risk — read directly from authStore (already populated by ProfilePage).
  // On every mode switch, also re-fetch the profile so the value is fresh even
  // if the user hasn't visited ProfilePage in this session.
  const botRisk = isCrypto ? bybit_risk_pct : oanda_risk_pct;
  const pollRef = useRef(null);

  useEffect(() => {
    getToken().then(token => fetchProfile(token)).catch(() => {});
  }, [isCrypto]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── WebSocket for live Oanda signals (FOREX mode) ─────────────────────────
  const { lastMessage } = useWebSocket(isCrypto ? null : "/ws");

  useEffect(() => {
    // GUARD: useWebSocket() always connects regardless of the URL argument.
    // In CRYPTO mode the WS delivers Oanda signals which must not appear on
    // the Bybit page. Drop all incoming WS messages when isCrypto is true —
    // Bybit signals arrive via the 30-second REST poll (fetchSignals below).
    if (isCrypto) return;
    if (!lastMessage) return;
    if (lastMessage.type === "SIGNAL" || lastMessage.type === "SIGNAL_HISTORY") {
      // Merge incoming Oanda WS signals into state (FOREX mode only)
      const incoming = Array.isArray(lastMessage.signals)
        ? lastMessage.signals
        : [lastMessage];
      setSignals(prev => {
        const seen = new Set(prev.map(dedupeKey));
        const merged = [...prev];
        for (const sig of incoming) {
          const key = dedupeKey(sig);
          if (!seen.has(key)) { seen.add(key); merged.push(sig); }
        }
        return merged.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)).slice(0, 100);
      });
      setLastUpdate(Date.now());
    }
  }, [lastMessage, isCrypto]);

  // ── Fetch signals (REST) ──────────────────────────────────────────────────
  const fetchSignals = useCallback(async () => {
    try {
      const endpoint = isCrypto ? "/bybit/signals" : "/signals";
      const { data } = await api.get(endpoint);
      const deduped = [];
      const seen    = new Set();
      for (const sig of (data ?? [])) {
        const key = dedupeKey(sig);
        if (!seen.has(key)) { seen.add(key); deduped.push(sig); }
      }
      setSignals(deduped);
      setLastUpdate(Date.now());
      setError(null);
    } catch (e) {
      setError(e?.userMessage ?? "Could not load signals");
    } finally {
      setLoading(false);
    }
  }, [isCrypto]);

  // ── Fetch trade locks ─────────────────────────────────────────────────────
  const fetchTradeLocks = useCallback(async () => {
    try {
      // Trade locks apply to both engines — locked instruments on either side
      const { data } = await api.get("/bybit/trade-locks");
      setTradeLocks(data ?? {});
    } catch { /* non-critical */ }
  }, []);

  // ── Mount / mode switch ───────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    setSignals([]);
    setActiveTab("Active");
    fetchSignals();
    fetchTradeLocks();

    // Only poll in CRYPTO mode (Oanda gets WS push; Bybit needs REST polling)
    if (isCrypto) {
      pollRef.current = setInterval(() => {
        fetchSignals();
        fetchTradeLocks();
      }, 30_000);
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [isCrypto, fetchSignals, fetchTradeLocks]);

  // ── Split signals into Active / History ───────────────────────────────────
  // TRUTH LOGIC: Active tab requires BOTH:
  //   1. Signal was 100% confluence (only 100% signals are real trade setups)
  //   2. Instrument is currently locked  OR  signal is within the 2h TTL window
  // If the market has moved below 100%, the signal drops from Active automatically.
  // ACTIVE TAB: 100% confluence + instrument locked OR recent + NOT failed
  // If execution failed, signal moves to History immediately (no lingering in Active)
  const activeSignals  = signals.filter(s => {
    if ((s.confidence ?? 0) < 100) return false;
    if (s.exec_status === "failed")  return false;  // ← FAILED → History tab immediately
    const sym = s.instrument ?? s.symbol ?? "";
    return Boolean(tradeLocks[sym]) || isRecent(s);
  });
  // HISTORY TAB: everything else — sub-100%, failed executions, expired 100% signals
  const historySignals = signals.filter(s => {
    if (s.exec_status === "failed") return true;    // ← always show failed in History
    const isActive100 = (s.confidence ?? 0) >= 100 &&
      (Boolean(tradeLocks[s.instrument ?? s.symbol ?? ""]) || isRecent(s));
    return !isActive100;
  });
  const displaySignals = activeTab === "Active" ? activeSignals : historySignals;

  return (
    <div style={{ fontFamily: FONT_UI, color: C.white, minHeight: "100%" }}>

      {/* ── Sticky header ───────────────────────────────────────────────── */}
      <div style={{
        position:             "sticky",
        top:                  0,
        zIndex:               20,
        background:           "rgba(5,5,5,0.97)",
        backdropFilter:       "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderBottom:         `1px solid ${accent}14`,
        transition:           "border-color 0.4s ease",
      }}>
        {/* Title row */}
        <div style={{
          padding: "16px 16px 0",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h1 style={{
                color: C.white, fontSize: "1.2rem", fontWeight: 700,
                letterSpacing: "0.03em", margin: 0,
              }}>
                Signals
              </h1>
              {/* Bot active indicator */}
              <motion.div
                animate={{ opacity: [0.5, 1, 0.5], boxShadow: [`0 0 4px ${accent}`, `0 0 10px ${accent}`, `0 0 4px ${accent}`] }}
                transition={{ duration: 2, repeat: Infinity }}
                style={{
                  width: 7, height: 7, borderRadius: "50%",
                  background: accent, flexShrink: 0,
                  transition: "background 0.4s",
                }}
              />
              <span style={{
                fontSize: "0.55rem", fontWeight: 700, letterSpacing: "0.1em",
                padding: "2px 7px", borderRadius: 5, fontFamily: FONT_MONO,
                background: `${accent}12`, border: `1px solid ${accent}30`,
                color: accent,
              }}>
                BOT ACTIVE
              </span>
            </div>
            <p style={{ color: C.sub, fontSize: "0.62rem", margin: "4px 0 0", fontFamily: FONT_MONO }}>
              {isCrypto ? "Bybit Linear · SMC 1:3 RR · 20× Isolated" : "Oanda v20 · SMC 1:3 RR · Precision Sizing"}
              {botRisk != null && (
                <span style={{ color: accent, marginLeft: 6 }}>
                  · Risk {parseFloat(botRisk).toFixed(1)}%
                </span>
              )}
              {lastUpdate && ` · ${fmtAgo(lastUpdate / 1000)}`}
            </p>
          </div>
        </div>

        {/* Tab bar */}
        <div style={{ display: "flex", gap: 0, padding: "10px 16px 0" }}>
          {[
            { id: "Active",  label: "Active",  count: activeSignals.length  },
            { id: "History", label: "History", count: historySignals.length },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                flex: 1,
                padding:    "10px 0",
                background: "transparent",
                border:     "none",
                borderBottom: `2px solid ${activeTab === tab.id ? accent : "transparent"}`,
                cursor:     "pointer",
                transition: "border-color 0.25s",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <span style={{
                color:         activeTab === tab.id ? C.white : C.sub,
                fontSize:      "0.75rem",
                fontWeight:    activeTab === tab.id ? 700 : 400,
                fontFamily:    FONT_UI,
                letterSpacing: "0.04em",
                transition:    "color 0.25s",
              }}>
                {tab.label}
              </span>
              {tab.count > 0 && (
                <span style={{
                  marginLeft: 6, fontSize: "0.6rem", fontWeight: 700,
                  padding: "1px 6px", borderRadius: 99,
                  background: activeTab === tab.id ? `${accent}18` : "rgba(255,255,255,0.06)",
                  border:     `1px solid ${activeTab === tab.id ? `${accent}35` : C.cardBdr}`,
                  color:      activeTab === tab.id ? accent : C.sub,
                  fontFamily: FONT_MONO,
                }}>
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      <div style={{ padding: "16px 16px 40px", display: "flex", flexDirection: "column", gap: 10 }}>

        {/* Loading */}
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

        {/* Error */}
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

        {/* Empty state — tab-aware */}
        {!loading && !error && displaySignals.length === 0 && (
          <motion.div
            key={activeTab}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            style={{ textAlign: "center", paddingTop: 48 }}
          >
            <div style={{ fontSize: "2.4rem", marginBottom: 12 }}>
              {activeTab === "Active" ? (isCrypto ? "₿" : "📡") : "📋"}
            </div>
            <p style={{ color: C.label, fontSize: "0.88rem", fontWeight: 600, margin: "0 0 6px" }}>
              {activeTab === "Active" ? "Scanning for setups…" : "No historical signals yet"}
            </p>
            <p style={{ color: C.sub, fontSize: "0.72rem", margin: 0 }}>
              {activeTab === "Active"
                ? "All 3 SMC layers must confirm before the bot fires."
                : "Past signals will appear here after their 2-hour window expires."}
            </p>
          </motion.div>
        )}

        {/* Signal cards */}
        <AnimatePresence mode="popLayout">
          {displaySignals.map((sig, idx) => {
            const sym    = sig.instrument ?? sig.symbol ?? "";
            const locked = Boolean(tradeLocks[sym]);
            return (
              <motion.div
                key={`${sym}${sig.direction}${sig.timestamp}`}
                layout
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.22, delay: idx * 0.03 }}
              >
                <SignalCard
                  sig={sig}
                  locked={locked}
                  isActive={activeTab === "Active"}
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

      <style>{`@keyframes pulse{0%,100%{opacity:.5}50%{opacity:1}}`}</style>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  SignalCard
// ─────────────────────────────────────────────────────────────────────────────
function SignalCard({ sig, locked, isActive, isCrypto, accent, accentDim, accentBdr }) {
  const [expanded, setExpanded] = useState(false);

  const isLong    = sig.direction === "LONG";
  // Spec-exact colors: true green / true red (not pinkish)
  const dirColor  = isLong ? "#00FF41" : "#FF0000";
  const sym       = (sig.instrument ?? sig.symbol ?? "").replace("_", "/");
  const conf      = sig.confidence ?? 0;
  const dp        = isCrypto ? 4 : 5;

  // ── Layered Confluence Color Evolution ──────────────────────────────────
  // L1 (34%) grey → L2 (67%) amber → L3 (100%) neon green/red
  const confColor = conf >= 100
    ? (isLong ? "#00FF00" : "#FF0000")
    : conf >= 67
    ? "#FFB800"
    : conf >= 34
    ? "#888888"
    : C.sub;

  // ── Execution badge (backed by API result, not just confidence level) ────
  const execStatus = sig.exec_status ?? null;
  const execOk     = execStatus === "ok";
  const execFailed = execStatus === "failed";

  // Panic glow at 100%
  const isPanic = conf >= 100;

  return (
    <motion.div
      layout
      animate={{ boxShadow: isPanic ? [
        "0 0 0px transparent",
        `0 0 24px ${isLong ? "#00FF0030" : "#FF000030"}`,
        "0 0 0px transparent",
      ] : "none" }}
      transition={isPanic ? { duration: 2, repeat: Infinity, ease: "easeInOut" } : {}}
      style={{
        borderRadius: 18, overflow: "hidden",
        background:   C.card,
        border:       locked
          ? "1px solid rgba(255,165,0,0.35)"
          : isPanic
          ? `1px solid ${isLong ? "rgba(0,255,0,0.30)" : "rgba(255,0,0,0.30)"}`
          : `1px solid ${C.cardBdr}`,
        opacity:      !isActive ? 0.65 : 1,
      }}
    >
      {/* ── Header ────────────────────────────────────────────────────── */}
      <button
        onClick={() => setExpanded(p => !p)}
        style={{
          width: "100%", background: "transparent", border: "none",
          padding: "14px 16px", cursor: "pointer",
          display: "flex", alignItems: "center", gap: 12, textAlign: "left",
        }}
      >
        <div style={{
          width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
          background: dirColor, boxShadow: `0 0 8px ${dirColor}80`,
        }} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{
              color: C.white, fontSize: "1.1rem", fontWeight: 700, fontFamily: FONT_MONO,
              textShadow: "0 0 8px rgba(255,255,255,0.15)",
            }}>
              {sym}
            </span>
            <span style={{
              fontSize: "0.7rem", fontWeight: 800, letterSpacing: "0.1em",
              padding: "3px 9px", borderRadius: 6,
              background: isLong ? "rgba(0,255,65,0.12)" : "rgba(255,0,0,0.12)",
              border: `1px solid ${dirColor}50`,
              color: dirColor, fontFamily: FONT_MONO,
              // Spec: true green #00FF00 glow for LONG, true red #FF0000 for SHORT
              textShadow: isLong
                ? "0 0 12px rgba(0,255,0,0.9)"
                : "0 0 12px rgba(255,0,0,0.9)",
              filter: `drop-shadow(0 0 8px ${dirColor}bb)`,
            }}>
              {isLong ? "LONG" : "SHORT"}
            </span>
            {locked && (
              <span style={{
                fontSize: "0.62rem", fontWeight: 700, padding: "3px 9px", borderRadius: 6,
                background: "rgba(255,165,0,0.12)", border: "1px solid rgba(255,165,0,0.3)",
                color: "#FFA500", fontFamily: FONT_MONO,
              }}>🔒 POSITION OPEN</span>
            )}
            {execOk && !locked && (
              <span style={{
                fontSize: "0.62rem", fontWeight: 700, padding: "3px 9px", borderRadius: 6,
                background: "rgba(0,255,0,0.10)", border: "1px solid rgba(0,255,0,0.28)",
                color: "#00FF00", fontFamily: FONT_MONO,
                filter: "drop-shadow(0 0 6px rgba(0,255,0,0.7))",
              }}>✓ BOT EXECUTED</span>
            )}
            {execFailed && (
              <span style={{
                fontSize: "0.62rem", fontWeight: 700, padding: "3px 9px", borderRadius: 6,
                background: "rgba(255,0,0,0.10)", border: "1px solid rgba(255,0,0,0.30)",
                color: "#FF0000", fontFamily: FONT_MONO,
                filter: "drop-shadow(0 0 6px rgba(255,0,0,0.5))",
              }}>✗ EXECUTION FAILED</span>
            )}
          </div>
          <p style={{ color: C.sub, fontSize: "0.72rem", margin: "3px 0 0", fontFamily: FONT_MONO }}>
            {fmtDate(sig.timestamp)} · {fmtTime(sig.timestamp)} · {fmtAgo(sig.timestamp)}
          </p>
        </div>

        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <motion.p
            animate={{
              color: confColor,
              // Layered glow: none at L1, subtle at L2, intense at L3
              textShadow: conf >= 100
                ? `0 0 14px ${confColor}, 0 0 28px ${confColor}90`
                : conf >= 67
                ? `0 0 8px ${confColor}80`
                : "none",
            }}
            transition={{ duration: 0.3 }}
            style={{ fontSize: "1.44rem", fontWeight: 800, fontFamily: FONT_MONO, margin: 0 }}
          >
            {conf}%
          </motion.p>
          <p style={{ color: conf >= 100 ? confColor : C.sub, fontSize: "0.62rem", margin: "2px 0 0", letterSpacing: "0.06em" }}>
            {conf >= 100 ? "FULL CONF" : conf >= 67 ? "L2 ZONE" : conf >= 34 ? "L1 TREND" : "SCANNING"}
          </p>
        </div>

        <motion.div
          animate={{ rotate: expanded ? 180 : 0 }}
          style={{ color: C.sub, fontSize: "0.7rem", flexShrink: 0 }}
        >▾</motion.div>
      </button>

      {/* ── Price levels ─────────────────────────────────────────────── */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
        borderTop: `1px solid ${C.cardBdr}`,
      }}>
        {[
          { label: "ENTRY", value: fmtPrice(sig.entry, dp), color: C.white },
          { label: "SL",    value: fmtPrice(sig.sl,    dp), color: C.red   },
          { label: "TP",    value: fmtPrice(sig.tp,    dp), color: C.green },
        ].map(({ label, value, color }, i) => (
          <div key={label} style={{
            textAlign: "center", padding: "10px 8px",
            borderRight: i < 2 ? `1px solid ${C.cardBdr}` : "none",
          }}>
            <p style={{ color: C.sub, fontSize: "0.62rem", letterSpacing: "0.1em", margin: "0 0 3px", fontFamily: FONT_UI }}>{label}</p>
            <p style={{ color, fontSize: "0.9rem", fontWeight: 600, margin: 0, fontFamily: FONT_MONO }}>{value}</p>
          </div>
        ))}
      </div>

      {/* ── Expandable detail ────────────────────────────────────────── */}
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
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                <LayerBadge label="L1 Trend" active={!!sig.layer1} value={sig.layer1}          accent={accent} isLong={isLong} />
                <LayerBadge label="L2 Zone"  active={!!sig.layer2} value={sig.layer2 ? "OB/FVG" : null} accent={accent} isLong={isLong} />
                <LayerBadge label="L3 MSS"   active={!!sig.layer3} value={sig.layer3 ? "CHoCH" : null} accent={accent} isLong={isLong} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <DetailRow label="Breakeven"   value={fmtPrice(sig.breakeven, dp)} mono />
                <DetailRow label="Risk/Reward" value={`1 : ${sig.rr ?? "3.0"}`} mono />
                <DetailRow label="Engine"      value={isCrypto ? "Bybit Linear · 20× Isolated" : "Oanda v20 · Max Margin"} />
                {locked && (
                  <div style={{
                    marginTop: 4, padding: "8px 12px", borderRadius: 8,
                    background: "rgba(255,165,0,0.07)", border: "1px solid rgba(255,165,0,0.22)",
                    color: "#FFA500", fontSize: "0.67rem",
                  }}>
                    🔒 Position open. No new entries for this instrument until SL/TP hit or 2h TTL expires.
                  </div>
                )}
                {sig.exec_error && (
                  <div style={{
                    marginTop: 4, padding: "8px 12px", borderRadius: 8,
                    background: "rgba(255,0,0,0.07)", border: "1px solid rgba(255,0,0,0.22)",
                    color: "#FF4444", fontSize: "0.67rem",
                  }}>
                    ✗ Execution failed: {sig.exec_error}
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

// ── Layer color map: L1=grey, L2=amber, L3=accent (per direction) ───────────
const LAYER_COLORS = {
  "L1 Trend": { active: "#888888", glow: "rgba(136,136,136,0.4)" },
  "L2 Zone":  { active: "#FFB800", glow: "rgba(255,184,0,0.5)"   },
  "L3 MSS":   { active: "#00FF41", glow: "rgba(0,255,65,0.6)"    },
};

function LayerBadge({ label, active, value, accent, isLong }) {
  // Use per-layer color when active; grey when inactive
  const layerColor = LAYER_COLORS[label];
  const activeColor = label === "L3 MSS"
    ? (isLong ? "#00FF00" : "#FF0000")   // L3 uses direction color
    : (layerColor?.active ?? accent);
  const glowColor   = label === "L3 MSS"
    ? (isLong ? "rgba(0,255,0,0.6)" : "rgba(255,0,0,0.6)")
    : (layerColor?.glow ?? "transparent");
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 5,
      padding: "4px 10px", borderRadius: 8,
      background: active ? `${activeColor}12` : "rgba(255,255,255,0.03)",
      border: `1px solid ${active ? `${activeColor}40` : C.cardBdr}`,
      filter: active && label === "L3 MSS" ? `drop-shadow(0 0 4px ${glowColor})` : "none",
    }}>
      <div style={{
        width: 6, height: 6, borderRadius: "50%",
        background: active ? activeColor : C.sub,
        boxShadow: active ? `0 0 5px ${activeColor}` : "none",
      }} />
      <span style={{
        color: active ? activeColor : C.sub,
        fontSize: "0.6rem", fontWeight: 700,
        fontFamily: FONT_MONO, letterSpacing: "0.06em",
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