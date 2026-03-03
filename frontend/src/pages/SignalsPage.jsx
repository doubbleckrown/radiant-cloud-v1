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
/** 5-min dedup bucket */
function dedupeKey(sig) {
  const bucket = Math.floor((sig.timestamp || 0) / 300);
  return `${sig.instrument ?? sig.symbol}|${sig.direction}|${bucket}`;
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
  const [activeTab,  setActiveTab]  = useState("Active");
  const [signals,    setSignals]    = useState([]);
  const [tradeLocks, setTradeLocks] = useState({});
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  // Bot risk shown in header — pulled from server to stay in sync with ProfilePage
  const [botRisk,    setBotRisk]    = useState(null);
  const pollRef = useRef(null);

  // ── Pull authoritative risk % from server on every mount/mode switch ──────
  // Prevents UI from showing a stale value after navigating away & back.
  useEffect(() => {
    api.get("/settings")
      .then(({ data }) => { if (data?.risk_pct != null) setBotRisk(data.risk_pct); })
      .catch(() => {});
  }, [isCrypto]);

  // ── WebSocket for live Oanda signals (FOREX mode) ─────────────────────────
  const { lastMessage } = useWebSocket(isCrypto ? null : "/ws");

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === "SIGNAL" || lastMessage.type === "SIGNAL_HISTORY") {
      // Merge incoming WS signals into state
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
  }, [lastMessage]);

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
  const activeSignals  = signals.filter(s => {
    const sym = s.instrument ?? s.symbol ?? "";
    return Boolean(tradeLocks[sym]) || isRecent(s);
  });
  const historySignals = signals.filter(s => {
    const sym = s.instrument ?? s.symbol ?? "";
    return !Boolean(tradeLocks[sym]) && !isRecent(s);
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
  const dirColor  = isLong ? C.green : C.red;
  const sym       = (sig.instrument ?? sig.symbol ?? "").replace("_", "/");
  const conf      = sig.confidence ?? 0;
  const confColor = conf >= 100 ? accent : conf >= 80 ? C.amber : C.label;
  const wasExec   = conf >= 100; // bot executed this
  const dp        = isCrypto ? 4 : 5;

  return (
    <motion.div
      layout
      style={{
        borderRadius: 18, overflow: "hidden",
        background:   C.card,
        border:       locked
          ? "1px solid rgba(255,165,0,0.35)"
          : wasExec
          ? `1px solid ${accent}30`
          : `1px solid ${C.cardBdr}`,
        opacity:      !isActive ? 0.65 : 1,
        boxShadow:    wasExec ? `0 0 22px ${accent}14` : "none",
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
              background: `${dirColor}18`, border: `1px solid ${dirColor}40`,
              color: dirColor, fontFamily: FONT_MONO,
              filter: `drop-shadow(0 0 8px ${dirColor}cc)`,
            }}>
              {isLong ? "BULLISH" : "BEARISH"}
            </span>
            {locked && (
              <span style={{
                fontSize: "0.62rem", fontWeight: 700, padding: "3px 9px", borderRadius: 6,
                background: "rgba(255,165,0,0.12)", border: "1px solid rgba(255,165,0,0.3)",
                color: "#FFA500", fontFamily: FONT_MONO,
              }}>🔒 POSITION OPEN</span>
            )}
            {wasExec && !locked && (
              <span style={{
                fontSize: "0.62rem", fontWeight: 700, padding: "3px 9px", borderRadius: 6,
                background: `${accent}10`, border: `1px solid ${accent}28`,
                color: accent, fontFamily: FONT_MONO,
                filter: `drop-shadow(0 0 6px ${accent}99)`,
              }}>✓ BOT EXECUTED</span>
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
              textShadow: conf >= 100 ? `0 0 12px ${confColor}, 0 0 24px ${confColor}80` : "none",
            }}
            transition={{ duration: 0.3 }}
            style={{ fontSize: "1.44rem", fontWeight: 800, fontFamily: FONT_MONO, margin: 0 }}
          >
            {conf}%
          </motion.p>
          <p style={{ color: C.sub, fontSize: "0.62rem", margin: "2px 0 0", letterSpacing: "0.06em" }}>
            CONFLUENCE
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
                <LayerBadge label="L1 Trend" active={!!sig.layer1} value={sig.layer1}          accent={accent} />
                <LayerBadge label="L2 Zone"  active={!!sig.layer2} value={sig.layer2 ? "OB/FVG" : null} accent={accent} />
                <LayerBadge label="L3 MSS"   active={!!sig.layer3} value={sig.layer3 ? "CHoCH" : null} accent={accent} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <DetailRow label="Breakeven"   value={fmtPrice(sig.breakeven, dp)} mono />
                <DetailRow label="Risk/Reward" value={`1 : ${sig.rr ?? (isCrypto ? "3.0" : "2.0")}`} mono />
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
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function LayerBadge({ label, active, value, accent }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 5,
      padding: "4px 10px", borderRadius: 8,
      background: active ? `${accent}12` : "rgba(255,255,255,0.03)",
      border: `1px solid ${active ? `${accent}35` : C.cardBdr}`,
    }}>
      <div style={{
        width: 6, height: 6, borderRadius: "50%",
        background: active ? accent : C.sub,
        boxShadow: active ? `0 0 5px ${accent}` : "none",
      }} />
      <span style={{
        color: active ? accent : C.sub,
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