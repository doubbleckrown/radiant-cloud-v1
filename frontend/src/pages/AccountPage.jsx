/**
 * AccountPage
 * ══════════════════════════════════════════════════════════════════
 * Layout (top → bottom):
 *   1. Sticky header  ← now includes a BalanceSparkline drawn from history
 *   2. Master Auto-Trade toggle
 *   3. Tab bar: Summary | Open Trades | History
 *   4. Tab content panel
 *      - Open Trades: accordion expansion per row (TradeDetailCard)
 *      - History:     accordion expansion per row (TradeDetailCard)
 *
 * ALL text uses explicit inline color values so text is readable on every
 * deployment target (Vercel, iPhone Safari) without depending on Tailwind.
 *
 * Backend routes consumed:
 *   GET  /api/account            → summary
 *   GET  /api/account/trades     → open positions
 *   GET  /api/account/history    → last 50 closed trades  (also drives sparkline)
 *   GET  /api/auth/me            → auto_trade_enabled
 *   PATCH /api/users/me/settings → toggle auto_trade_enabled
 */
import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import api from "../utils/api";
import { useAuthStore } from "../store/authStore";
import { useUser } from "@clerk/clerk-react";

// ── Shared colour tokens ──────────────────────────────────────────────────────
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

const TABS = ["Summary", "Open Trades", "History"];

// ─────────────────────────────────────────────────────────────────────────────
export default function AccountPage() {
  const { user: clerkUser } = useUser();
  const { auto_trade_enabled, fetchMe, updateAutoTrade } = useAuthStore();

  const [toggling,    setToggling]    = useState(false);
  const [toggleError, setToggleError] = useState(null);
  const autoTradeOn = auto_trade_enabled ?? false;

  const [activeTab,      setActiveTab]      = useState("Summary");
  const [account,        setAccount]        = useState(null);
  const [trades,         setTrades]         = useState([]);
  const [history,        setHistory]        = useState([]);
  const [loading,        setLoading]        = useState({});
  const [errors,         setErrors]         = useState({});
  const [sparklinePoints, setSparklinePoints] = useState([]);  // ← NEW

  useEffect(() => { fetchMe(); }, []); // eslint-disable-line

  // ── Eagerly load history on mount for the header sparkline ─────────────────
  // This also pre-fills the History tab so it doesn't need to re-fetch.
  useEffect(() => {
    api.get("/account/history")
      .then(({ data }) => {
        if (!Array.isArray(data) || data.length === 0) return;
        // Sort oldest → newest, then build a running-PnL series
        const sorted = [...data].sort(
          (a, b) => new Date(a.closeTime ?? 0) - new Date(b.closeTime ?? 0)
        );
        let running = 0;
        const pts = sorted.map(t => {
          running += parseFloat(t.realizedPL ?? 0);
          return running;
        });
        setSparklinePoints(pts);
        setHistory(data); // pre-fill History tab
      })
      .catch(() => {});
  }, []); // eslint-disable-line

  useEffect(() => {
    if (activeTab === "Summary"     && !account)       loadSummary();
    if (activeTab === "Open Trades" && !trades.length) loadTrades();
    if (activeTab === "History"     && !history.length) loadHistory();
  }, [activeTab]); // eslint-disable-line

  const mark = (tab, isLoading, err = null) => {
    setLoading(p => ({ ...p, [tab]: isLoading }));
    setErrors( p => ({ ...p, [tab]: err }));
  };

  const loadSummary = useCallback(async () => {
    mark("Summary", true);
    try   { const { data } = await api.get("/account"); setAccount(data); mark("Summary", false); }
    catch (e) { mark("Summary", false, e.userMessage ?? "Could not load account"); }
  }, []);

  const loadTrades = useCallback(async () => {
    mark("Open Trades", true);
    try   { const { data } = await api.get("/account/trades"); setTrades(data ?? []); mark("Open Trades", false); }
    catch (e) { mark("Open Trades", false, e.userMessage ?? "Could not load trades"); }
  }, []);

  const loadHistory = useCallback(async () => {
    mark("History", true);
    try   { const { data } = await api.get("/account/history"); setHistory(data ?? []); mark("History", false); }
    catch (e) { mark("History", false, e.userMessage ?? "Could not load history"); }
  }, []);

  const handleToggle = useCallback(async () => {
    if (toggling) return;
    setToggling(true); setToggleError(null);
    try   { await updateAutoTrade(!autoTradeOn); }
    catch (e) { setToggleError(e.userMessage ?? "Could not save setting"); }
    finally   { setToggling(false); }
  }, [toggling, autoTradeOn, updateAutoTrade]);

  return (
    <div style={{ fontFamily: FONT_UI, color: C.white, minHeight: "100%" }}>

      {/* ── Sticky header ──────────────────────────────────────────────── */}
      <div style={{
        position: "sticky", top: 0, zIndex: 20,
        padding: "16px 16px 12px",
        background: "rgba(5,5,5,0.97)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderBottom: "1px solid rgba(0,255,65,0.08)",
      }}>
        {/* Title row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1 style={{ color: C.white, fontSize: "1.2rem", fontWeight: 700, letterSpacing: "0.03em", margin: 0, fontFamily: FONT_UI }}>
              Account
            </h1>
            <p style={{ color: C.label, fontSize: "0.7rem", margin: "2px 0 0", fontFamily: FONT_UI }}>Oanda v20 · Live data</p>
          </div>

          {/* ── Balance Sparkline (middle) ── */}
          {sparklinePoints.length > 1 && (
            <BalanceSparkline points={sparklinePoints} />
          )}

          {/* LIVE badge */}
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "6px 12px", borderRadius: 99,
            background: "rgba(0,255,65,0.07)", border: "1px solid rgba(0,255,65,0.18)",
          }}>
            <motion.div
              animate={{ opacity: [1, 0.25, 1] }}
              transition={{ duration: 1.4, repeat: Infinity }}
              style={{ width: 6, height: 6, borderRadius: "50%", background: C.green }}
            />
            <span style={{ color: C.green, fontSize: "0.65rem", fontWeight: 700, letterSpacing: "0.1em", fontFamily: FONT_UI }}>LIVE</span>
          </div>
        </div>
      </div>

      {/* ── Content ───────────────────────────────────────────────────── */}
      <div style={{ padding: "16px 16px 32px", display: "flex", flexDirection: "column", gap: 12 }}>

        {/* AUTO-TRADE TOGGLE */}
        <AutoTradeToggle isOn={autoTradeOn} toggling={toggling} error={toggleError} onToggle={handleToggle} />

        {/* TAB BAR */}
        <div style={{
          display: "flex", borderRadius: 16, overflow: "hidden",
          background: C.card, border: `1px solid ${C.cardBdr}`,
        }}>
          {TABS.map(tab => {
            const active = activeTab === tab;
            return (
              <motion.button
                key={tab}
                onClick={() => setActiveTab(tab)}
                whileTap={{ scale: 0.97 }}
                style={{
                  flex: 1, minHeight: 46, border: "none",
                  background: active ? C.greenDim : "transparent",
                  color: active ? C.green : C.label,
                  fontSize: "0.72rem", fontWeight: active ? 700 : 500,
                  letterSpacing: "0.07em", cursor: "pointer",
                  position: "relative",
                  transition: "background 0.18s, color 0.18s",
                  fontFamily: FONT_UI,
                }}
              >
                {tab.toUpperCase()}
                {active && (
                  <motion.div
                    layoutId="tab-line"
                    style={{
                      position: "absolute", bottom: 0, left: "8%", right: "8%",
                      height: 2, borderRadius: 1,
                      background: C.green, boxShadow: `0 0 8px ${C.green}`,
                    }}
                  />
                )}
              </motion.button>
            );
          })}
        </div>

        {/* TAB CONTENT */}
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
          >
            {activeTab === "Summary"     && <SummaryTab    account={account} loading={loading.Summary}         error={errors.Summary}         onRetry={loadSummary} />}
            {activeTab === "Open Trades" && <OpenTradesTab trades={trades}   loading={loading["Open Trades"]}  error={errors["Open Trades"]}  onRetry={loadTrades}  />}
            {activeTab === "History"     && <HistoryTab    history={history}  loading={loading.History}         error={errors.History}         onRetry={loadHistory} />}
          </motion.div>
        </AnimatePresence>

      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  BalanceSparkline — inline SVG line chart for the header
//  Points are a cumulative-PnL array built from history data.
// ─────────────────────────────────────────────────────────────────────────────
function BalanceSparkline({ points }) {
  const W = 88, H = 32;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;

  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * W;
    const y = H - 4 - ((p - min) / range) * (H - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const pathD  = "M" + coords.join(" L");
  const lastPnl = points[points.length - 1];
  const color   = lastPnl >= 0 ? C.green : C.red;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ overflow: "visible" }}>
        {/* Zero line */}
        {min < 0 && max > 0 && (
          <line
            x1="0" y1={H - 4 - ((-min) / range) * (H - 8)}
            x2={W} y2={H - 4 - ((-min) / range) * (H - 8)}
            stroke="rgba(255,255,255,0.08)" strokeWidth="1" strokeDasharray="3,3"
          />
        )}
        {/* Sparkline */}
        <path
          d={pathD}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ filter: `drop-shadow(0 0 3px ${color}80)` }}
        />
        {/* Last dot */}
        <circle
          cx={coords[coords.length - 1].split(",")[0]}
          cy={coords[coords.length - 1].split(",")[1]}
          r="2.5"
          fill={color}
          style={{ filter: `drop-shadow(0 0 4px ${color})` }}
        />
      </svg>
      <span style={{
        color:         C.sub,
        fontSize:      "0.55rem",
        fontFamily:    FONT_MONO,
        letterSpacing: "0.06em",
      }}>
        {lastPnl >= 0 ? "+" : ""}{lastPnl.toFixed(2)} P&L
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  AutoTradeToggle  (UNCHANGED)
// ─────────────────────────────────────────────────────────────────────────────
function AutoTradeToggle({ isOn, toggling, error, onToggle }) {
  return (
    <motion.div
      className={isOn ? "border-glow-green" : ""}
      animate={{ background: isOn ? "rgba(0,255,65,0.06)" : C.card }}
      transition={{ duration: 0.25 }}
      style={{
        borderRadius: 16,
        border: `1px solid ${isOn ? C.greenBdr : C.cardBdr}`,
      }}
    >
      <div style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <motion.div
            animate={{ background: isOn ? "rgba(0,255,65,0.14)" : "rgba(255,255,255,0.05)" }}
            transition={{ duration: 0.2 }}
            style={{
              width: 44, height: 44, borderRadius: 12,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "1.3rem", flexShrink: 0,
              border: `1px solid ${isOn ? "rgba(0,255,65,0.3)" : C.cardBdr}`,
            }}
          >
            {isOn ? "⚡" : "🤖"}
          </motion.div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ color: C.white, fontSize: "0.9rem", fontWeight: 600, margin: 0, letterSpacing: "0.02em", fontFamily: FONT_UI }}>
              Master Auto-Trade
            </p>
            <motion.p
              animate={{ color: isOn ? C.green : C.sub }}
              transition={{ duration: 0.2 }}
              style={{ fontSize: "0.68rem", margin: "3px 0 0", letterSpacing: "0.04em", fontFamily: FONT_UI }}
            >
              {isOn ? "ACTIVE — signals execute automatically" : "OFF — signals monitored only"}
            </motion.p>
          </div>
          <button
            onClick={onToggle}
            disabled={toggling}
            aria-pressed={isOn}
            aria-label={isOn ? "Disable auto-trade" : "Enable auto-trade"}
            style={{
              background: "transparent", border: "none",
              cursor: toggling ? "not-allowed" : "pointer",
              opacity: toggling ? 0.65 : 1,
              padding: 0, flexShrink: 0,
              minWidth: 44, minHeight: 44,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            {toggling ? (
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 0.6, repeat: Infinity, ease: "linear" }}
                style={{
                  width: 20, height: 20, borderRadius: "50%",
                  border: "2px solid transparent",
                  borderTopColor: isOn ? C.green : "#666",
                }}
              />
            ) : (
              <motion.div
                animate={{ backgroundColor: isOn ? C.green : "#1f1f1f" }}
                transition={{ duration: 0.2 }}
                style={{
                  width: 54, height: 28, borderRadius: 14, position: "relative",
                  border: `1px solid ${isOn ? "rgba(0,255,65,0.6)" : C.cardBdr}`,
                  boxShadow: isOn ? "0 0 10px rgba(0,255,65,0.4)" : "none",
                }}
              >
                <motion.div
                  animate={{ x: isOn ? 27 : 2 }}
                  transition={{ type: "spring", stiffness: 480, damping: 32 }}
                  style={{
                    position: "absolute", top: 3,
                    width: 20, height: 20, borderRadius: "50%",
                    background: isOn ? "#000" : "#555",
                    boxShadow: isOn ? "0 0 6px rgba(0,255,65,0.9)" : "none",
                  }}
                />
              </motion.div>
            )}
          </button>
        </div>
        <AnimatePresence>
          {isOn && (
            <motion.div
              initial={{ opacity: 0, height: 0, marginTop: 0 }}
              animate={{ opacity: 1, height: "auto", marginTop: 12 }}
              exit={{ opacity: 0, height: 0, marginTop: 0 }}
              style={{ overflow: "hidden" }}
            >
              <div style={{
                padding: "8px 12px", borderRadius: 10,
                background: "rgba(255,184,0,0.06)",
                border: "1px solid rgba(255,184,0,0.22)",
                color: C.amber, fontSize: "0.68rem", lineHeight: 1.5, fontFamily: FONT_UI,
              }}>
                ⚠ Live orders will be placed on 100%-confluence SMC signals.
                Verify position sizing and Oanda credentials before enabling.
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {error && (
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              style={{ marginTop: 8, fontSize: "0.68rem", color: C.red, fontFamily: FONT_UI }}
            >
              ✕ {error}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Shared helpers  (UNCHANGED)
// ─────────────────────────────────────────────────────────────────────────────
function TabLoading() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "64px 0" }}>
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
        style={{
          width: 32, height: 32, borderRadius: "50%",
          border: "2px solid transparent", borderTopColor: C.green,
        }}
      />
    </div>
  );
}

function TabError({ message, onRetry }) {
  return (
    <div style={{
      borderRadius: 16, padding: 16,
      background: "rgba(255,58,58,0.06)", border: "1px solid rgba(255,58,58,0.2)",
    }}>
      <p style={{ color: C.red, fontSize: "0.82rem", fontWeight: 600, margin: "0 0 6px", fontFamily: FONT_UI }}>Connection Error</p>
      <p style={{ color: C.label, fontSize: "0.72rem", lineHeight: 1.5, margin: 0, fontFamily: FONT_UI }}>{message}</p>
      <button
        onClick={onRetry}
        style={{
          marginTop: 12, padding: "6px 18px", borderRadius: 10,
          background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)",
          color: C.white, fontSize: "0.7rem", letterSpacing: "0.08em", cursor: "pointer", fontFamily: FONT_UI,
        }}
      >
        RETRY
      </button>
    </div>
  );
}

function TabEmpty({ icon, title, sub }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "64px 0", gap: 12 }}>
      <div style={{
        width: 56, height: 56, borderRadius: "50%",
        background: "rgba(0,255,65,0.06)", border: "1px solid rgba(0,255,65,0.2)",
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.5rem",
      }}>{icon}</div>
      <div style={{ textAlign: "center" }}>
        <p style={{ color: C.label, fontSize: "0.8rem", letterSpacing: "0.05em", margin: "0 0 4px", fontFamily: FONT_UI }}>{title}</p>
        <p style={{ color: C.sub, fontSize: "0.68rem", margin: 0, fontFamily: FONT_UI }}>{sub}</p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Summary tab  (UNCHANGED)
// ─────────────────────────────────────────────────────────────────────────────
function SummaryTab({ account, loading, error, onRetry }) {
  if (loading) return <TabLoading />;
  if (error)   return <TabError message={error} onRetry={onRetry} />;
  if (!account) return null;

  const stats = [
    { label: "Balance",        value: `$${parseFloat(account.balance ?? 0).toFixed(2)}` },
    { label: "NAV",            value: `$${parseFloat(account.NAV ?? 0).toFixed(2)}` },
    { label: "Unrealised P&L", value: `$${parseFloat(account.unrealizedPL ?? 0).toFixed(2)}`, pnl: true },
    { label: "Open Trades",    value: String(account.openTradeCount ?? 0) },
    { label: "Margin Used",    value: `$${parseFloat(account.marginUsed ?? 0).toFixed(2)}` },
    { label: "Margin Avail.",  value: `$${parseFloat(account.marginAvailable ?? 0).toFixed(2)}` },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{
        padding: 16, borderRadius: 16,
        background: "rgba(0,255,65,0.04)", border: `1px solid ${C.greenBdr}`,
      }}>
        <p style={{ color: C.label, fontSize: "0.62rem", letterSpacing: "0.1em", margin: "0 0 6px", fontFamily: FONT_UI }}>ACCOUNT ID</p>
        <p style={{
          color: C.green, fontSize: "0.85rem", fontWeight: 700,
          fontFamily: FONT_MONO, margin: "0 0 4px",
        }}>{account.id}</p>
        <p style={{ color: C.label, fontSize: "0.7rem", textTransform: "capitalize", margin: 0, fontFamily: FONT_UI }}>
          {account.type?.toLowerCase() ?? "—"} account
        </p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {stats.map((stat, i) => {
          const pnlVal   = stat.pnl ? parseFloat(stat.value.replace("$","")) : null;
          const valColor = pnlVal !== null ? (pnlVal >= 0 ? C.green : C.red) : C.white;
          return (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04 }}
              style={{
                padding: 14, borderRadius: 14,
                background: C.card, border: `1px solid ${C.cardBdr}`,
              }}
            >
              <p style={{ color: C.label, fontSize: "0.6rem", letterSpacing: "0.1em", margin: "0 0 8px", fontFamily: FONT_UI }}>
                {stat.label.toUpperCase()}
              </p>
              <p style={{
                color: valColor, fontSize: "1.05rem", fontWeight: 700,
                fontFamily: FONT_MONO, margin: 0,
                textShadow: stat.pnl ? `0 0 8px ${valColor}60` : "none",
              }}>{stat.value}</p>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Open Trades tab  ← ACCORDION ADDED
// ─────────────────────────────────────────────────────────────────────────────
function OpenTradesTab({ trades, loading, error, onRetry }) {
  const [openId, setOpenId] = useState(null);

  if (loading) return <TabLoading />;
  if (error)   return <TabError message={error} onRetry={onRetry} />;
  if (!trades.length) return <TabEmpty icon="📭" title="No open positions" sub="Live trades will appear here once placed" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {trades.map((t, i) => {
        const units    = parseInt(t.currentUnits ?? t.initialUnits ?? 0);
        const isLong   = units > 0;
        const pnl      = parseFloat(t.unrealizedPL ?? 0);
        const pnlColor = pnl >= 0 ? C.green : C.red;
        const ins      = (t.instrument ?? "").replace("_", "/");
        const isOpen   = openId === t.id;

        return (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            style={{
              borderRadius: 16, overflow: "hidden",
              background:   C.card,
              border:       `1px solid ${isOpen
                ? (isLong ? C.greenBdr : "rgba(255,58,58,0.4)")
                : (isLong ? "rgba(0,255,65,0.22)" : "rgba(255,58,58,0.22)")}`,
              boxShadow: isOpen ? (isLong ? "0 0 20px rgba(0,255,65,0.07)" : "0 0 20px rgba(255,58,58,0.07)") : "none",
            }}
          >
            {/* Direction accent bar */}
            <div style={{
              height:     2,
              background: isLong
                ? "linear-gradient(90deg, transparent, #00FF41, transparent)"
                : "linear-gradient(90deg, transparent, #FF3A3A, transparent)",
            }} />

            {/* ── Tappable header row ───────────────────────────────────── */}
            <motion.div
              whileTap={{ scale: 0.99 }}
              onClick={() => setOpenId(isOpen ? null : t.id)}
              style={{ padding: 14, cursor: "pointer" }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: C.white, fontWeight: 700, fontSize: "0.95rem", fontFamily: FONT_UI }}>{ins}</span>
                  <span style={{
                    padding: "2px 8px", borderRadius: 6,
                    fontSize: "0.62rem", fontWeight: 700, letterSpacing: "0.07em",
                    color:       isLong ? C.green : C.red,
                    background:  isLong ? "rgba(0,255,65,0.12)" : "rgba(255,58,58,0.12)",
                    border:      `1px solid ${isLong ? C.greenBdr : "rgba(255,58,58,0.3)"}`,
                    fontFamily:  FONT_UI,
                  }}>
                    {isLong ? "▲ LONG" : "▼ SHORT"}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{
                    color: pnlColor, fontWeight: 700, fontSize: "0.9rem",
                    fontFamily: FONT_MONO,
                  }}>
                    {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}
                  </span>
                  {/* Chevron */}
                  <motion.div
                    animate={{ rotate: isOpen ? 180 : 0 }}
                    transition={{ duration: 0.2 }}
                    style={{ color: isOpen ? (isLong ? C.green : C.red) : C.sub }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </motion.div>
                </div>
              </div>

              {/* Mini stat row */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                {[
                  { label: "Units",  value: Math.abs(units).toLocaleString() },
                  { label: "Entry",  value: parseFloat(t.price ?? 0).toFixed(5) },
                  { label: "Margin", value: `$${parseFloat(t.marginUsed ?? 0).toFixed(2)}` },
                ].map(({ label, value }) => (
                  <div key={label} style={{
                    padding: "8px 6px", borderRadius: 10, textAlign: "center",
                    background: C.sheet, border: `1px solid ${C.cardBdr}`,
                  }}>
                    <p style={{ color: C.label, fontSize: "0.58rem", letterSpacing: "0.08em", margin: "0 0 4px", fontFamily: FONT_UI }}>
                      {label.toUpperCase()}
                    </p>
                    <p style={{ color: C.white, fontSize: "0.72rem", fontWeight: 600, fontFamily: FONT_MONO, margin: 0 }}>
                      {value}
                    </p>
                  </div>
                ))}
              </div>

              <p style={{ color: C.sub, fontSize: "0.62rem", marginTop: 10, fontFamily: FONT_UI }}>
                Opened {new Date(t.openTime).toLocaleString()}
              </p>
            </motion.div>

            {/* ── Accordion: Trade Detail Card ─────────────────────────── */}
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}
                  style={{ overflow: "hidden" }}
                >
                  <TradeDetailCard trade={t} kind="open" />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  History tab  ← ACCORDION ADDED
// ─────────────────────────────────────────────────────────────────────────────
function HistoryTab({ history, loading, error, onRetry }) {
  const [openId, setOpenId] = useState(null);

  if (loading) return <TabLoading />;
  if (error)   return <TabError message={error} onRetry={onRetry} />;
  if (!history.length) return <TabEmpty icon="📜" title="No closed trades" sub="Your trade history will appear here" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {history.map((t, i) => {
        const units    = parseInt(t.initialUnits ?? 0);
        const isLong   = units > 0;
        const pnl      = parseFloat(t.realizedPL ?? 0);
        const pnlColor = pnl >= 0 ? C.green : C.red;
        const ins      = (t.instrument ?? "").replace("_", "/");
        const isOpen   = openId === t.id;

        return (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.03, 0.3) }}
            style={{
              borderRadius: 14, overflow: "hidden",
              background:   C.card,
              border:       `1px solid ${isOpen ? (pnl >= 0 ? C.greenBdr : "rgba(255,58,58,0.4)") : C.cardBdr}`,
              boxShadow:    isOpen ? `0 0 16px ${pnlColor}10` : "none",
            }}
          >
            {/* ── Tappable summary row ──────────────────────────────────── */}
            <motion.div
              whileTap={{ scale: 0.99 }}
              onClick={() => setOpenId(isOpen ? null : t.id)}
              style={{
                display:    "flex",
                alignItems: "center",
                gap:        12,
                padding:    "12px 14px",
                cursor:     "pointer",
              }}
            >
              {/* Direction dot */}
              <div style={{
                width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                background: isLong ? C.green : C.red,
                boxShadow:  `0 0 6px ${isLong ? C.green : C.red}`,
              }} />

              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ color: C.white, fontSize: "0.88rem", fontWeight: 600, margin: "0 0 3px", fontFamily: FONT_UI }}>{ins}</p>
                <p style={{ color: C.sub, fontSize: "0.62rem", margin: 0, fontFamily: FONT_UI }}>
                  {isLong ? "Long" : "Short"} · {Math.abs(units).toLocaleString()} units
                </p>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ textAlign: "right" }}>
                  <p style={{
                    color: pnlColor, fontSize: "0.9rem", fontWeight: 700,
                    fontFamily: FONT_MONO,
                    textShadow: `0 0 6px ${pnlColor}60`, margin: "0 0 3px",
                  }}>
                    {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}
                  </p>
                  <p style={{ color: C.sub, fontSize: "0.6rem", margin: 0, fontFamily: FONT_UI }}>
                    {t.closeTime ? new Date(t.closeTime).toLocaleDateString() : "—"}
                  </p>
                </div>
                {/* Chevron */}
                <motion.div
                  animate={{ rotate: isOpen ? 180 : 0 }}
                  transition={{ duration: 0.2 }}
                  style={{ color: isOpen ? pnlColor : C.sub }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </motion.div>
              </div>
            </motion.div>

            {/* ── Accordion: Trade Detail Card ─────────────────────────── */}
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}
                  style={{ overflow: "hidden" }}
                >
                  <TradeDetailCard trade={t} kind="history" />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  TradeDetailCard — compact accordion panel · mobile-first
//
//  5 sections, all with tight padding so the card stays readable without
//  requiring the user to scroll past it on a phone screen:
//   1. Confluence banner  (icon · reason · badges)
//   2. P&L hero           (large number, tinted background)
//   3. Core metrics row   (Units · Entry · Risk)  — 3-col grid
//   4. Execution row      (SL · TP · Close/Live)  — 3-col grid
//   5. Timestamps         (Opened + Closed + duration pill + trade ID)
// ─────────────────────────────────────────────────────────────────────────────
function TradeDetailCard({ trade: t, kind }) {
  const isHistory = kind === "history";

  // Direction
  const rawUnits = parseInt(
    isHistory ? (t.initialUnits ?? 0) : (t.currentUnits ?? t.initialUnits ?? 0)
  );
  const isLong   = rawUnits > 0;
  const units    = Math.abs(rawUnits);
  const dirColor = isLong ? C.green : C.red;

  // P&L
  const pnl      = parseFloat(isHistory ? (t.realizedPL ?? 0) : (t.unrealizedPL ?? 0));
  const pnlColor = pnl >= 0 ? C.green : C.red;
  const pnlLabel = isHistory ? "Realized P&L" : "Unrealized P&L";
  const pnlSign  = pnl >= 0 ? "+" : "";

  // Prices
  const entryPx = parseFloat(t.price ?? 0);
  const closePx = parseFloat(t.averageClosePrice ?? 0);
  const slPx    = parseFloat(t.stopLossOrder?.price    ?? t.stopLossOrderID   ?? 0);
  const tpPx    = parseFloat(t.takeProfitOrder?.price  ?? t.takeProfitOrderID ?? 0);

  // Risk
  const margin     = parseFloat(t.marginUsed  ?? 0);
  const financing  = parseFloat(t.financing   ?? 0);
  const commission = parseFloat(t.commission  ?? 0);
  const riskAmt    = isHistory ? Math.abs(financing + commission) : margin;
  const riskLabel  = isHistory ? "Fees & Fin." : "Margin";

  // Confluence labels
  const conflTitle = isLong ? "SMC Bullish Order Block" : "SMC Bearish Order Block";
  const conflSub   = isLong
    ? "Demand Zone · Above 200 EMA · CHoCH confirmed"
    : "Supply Zone · Below 200 EMA · CHoCH confirmed";

  // Timestamps
  const openDt     = t.openTime  ? new Date(t.openTime)  : null;
  const closeDt    = t.closeTime ? new Date(t.closeTime) : null;
  const durationMs = openDt && closeDt ? closeDt - openDt : null;

  // Compact date+time on one line: "28 Oct 24 · 14:32"
  const fmtStamp = (d) => d
    ? d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "2-digit" }) +
      " · " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "—";

  // Price precision
  const dec = entryPx > 1000 ? 1 : entryPx > 100 ? 2 : 5;
  const fmt = (n) => n > 0 ? n.toFixed(dec) : "—";

  return (
    <div style={{
      margin:       "0 10px 10px",
      borderRadius: 12,
      overflow:     "hidden",
      border:       `1px solid ${isLong ? "rgba(0,255,65,0.18)" : "rgba(255,58,58,0.18)"}`,
      background:   C.sheet,
    }}>

      {/* ── 1. CONFLUENCE BANNER ─────────────────────────────────────────── */}
      <div style={{
        display:      "flex",
        alignItems:   "center",
        gap:          10,
        padding:      "8px 12px",
        borderBottom: `1px solid ${C.cardBdr}`,
        background:   isLong ? "rgba(0,255,65,0.03)" : "rgba(255,58,58,0.03)",
      }}>
        {/* Icon */}
        <div style={{
          width: 32, height: 32, borderRadius: 9, flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "1rem",
          background: isLong ? "rgba(0,255,65,0.1)" : "rgba(255,58,58,0.1)",
          border: `1px solid ${isLong ? C.greenBdr : "rgba(255,58,58,0.3)"}`,
        }}>
          {isLong ? "📈" : "📉"}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Title + badges on one line */}
          <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", marginBottom: 2 }}>
            <span style={{
              color: C.white, fontSize: "0.78rem", fontWeight: 700,
              fontFamily: FONT_UI, letterSpacing: "0.01em",
            }}>
              {conflTitle}
            </span>
            <span style={{
              padding: "1px 5px", borderRadius: 4, fontSize: "0.52rem",
              fontWeight: 700, letterSpacing: "0.08em",
              color: C.amber, background: "rgba(255,184,0,0.1)",
              border: "1px solid rgba(255,184,0,0.28)", fontFamily: FONT_UI,
            }}>SMC/ICT</span>
            <span style={{
              padding: "1px 5px", borderRadius: 4, fontSize: "0.52rem",
              fontWeight: 700, letterSpacing: "0.08em",
              color: dirColor,
              background: isLong ? "rgba(0,255,65,0.1)" : "rgba(255,58,58,0.1)",
              border: `1px solid ${isLong ? C.greenBdr : "rgba(255,58,58,0.3)"}`,
              fontFamily: FONT_UI,
            }}>
              {isLong ? "▲ LONG" : "▼ SHORT"}
            </span>
          </div>
          <p style={{ color: C.sub, fontSize: "0.6rem", margin: 0, fontFamily: FONT_UI, lineHeight: 1.3 }}>
            {conflSub}
          </p>
        </div>
      </div>

      {/* ── 2. P&L HERO ──────────────────────────────────────────────────── */}
      <div style={{
        padding:      "8px 14px 7px",
        borderBottom: `1px solid ${C.cardBdr}`,
        background:   pnl >= 0 ? "rgba(0,255,65,0.03)" : "rgba(255,58,58,0.03)",
        textAlign:    "center",
        position:     "relative",
        overflow:     "hidden",
      }}>
        {/* Glow orb */}
        <div style={{
          position: "absolute", top: "50%", left: "50%",
          transform: "translate(-50%,-50%)",
          width: 100, height: 44, borderRadius: "50%",
          background: pnl >= 0 ? "rgba(0,255,65,0.07)" : "rgba(255,58,58,0.07)",
          filter: "blur(16px)", pointerEvents: "none",
        }} />
        <p style={{
          color: pnlColor, fontSize: "1.6rem", fontWeight: 800,
          fontFamily: FONT_MONO, margin: 0, letterSpacing: "-0.02em",
          textShadow: `0 0 16px ${pnlColor}55`, lineHeight: 1, position: "relative",
        }}>
          {pnlSign}{Math.abs(pnl).toFixed(2)}
        </p>
        <p style={{
          color: C.sub, fontSize: "0.58rem", fontWeight: 600,
          letterSpacing: "0.12em", textTransform: "uppercase",
          margin: "3px 0 0", fontFamily: FONT_UI, position: "relative",
        }}>
          {pnlLabel}
        </p>
        {/* Colour bar */}
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0, height: 2,
          background: pnl >= 0
            ? "linear-gradient(90deg,transparent,#00FF41,transparent)"
            : "linear-gradient(90deg,transparent,#FF3A3A,transparent)",
        }} />
      </div>

      {/* ── 3. CORE METRICS — Units · Entry · Risk ───────────────────────── */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
        borderBottom: `1px solid ${C.cardBdr}`,
      }}>
        {[
          { label: "Units",       value: units.toLocaleString(),                 color: C.white, icon: "◈" },
          { label: "Entry",       value: fmt(entryPx),                           color: C.white, icon: "⤵" },
          { label: riskLabel,     value: riskAmt > 0 ? `$${riskAmt.toFixed(2)}` : "—", color: C.amber, icon: "⚖" },
        ].map(({ label, value, color, icon }, idx) => (
          <div key={label} style={{
            padding: "7px 6px", textAlign: "center",
            borderRight: idx < 2 ? `1px solid ${C.cardBdr}` : "none",
          }}>
            <p style={{
              color: C.sub, fontSize: "0.5rem", letterSpacing: "0.08em",
              textTransform: "uppercase", margin: "0 0 3px", fontFamily: FONT_UI,
            }}>
              {icon} {label}
            </p>
            <p style={{
              color, fontSize: "0.75rem", fontWeight: 700,
              fontFamily: FONT_MONO, margin: 0,
              textShadow: color !== C.white ? `0 0 6px ${color}40` : "none",
            }}>
              {value}
            </p>
          </div>
        ))}
      </div>

      {/* ── 4. EXECUTION DETAILS — SL · TP · Close/Live ─────────────────── */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
        borderBottom: `1px solid ${C.cardBdr}`,
      }}>
        {[
          { label: "Stop Loss",   value: fmt(slPx),   color: slPx > 0 ? C.red   : C.sub, icon: "🛑" },
          { label: "Take Profit", value: tpPx > 0 ? fmt(tpPx) : "—",
                                                       color: tpPx > 0 ? C.green : C.sub, icon: "🎯" },
          isHistory
            ? { label: "Close",   value: fmt(closePx), color: C.label, icon: "⤴" }
            : { label: "Live P&L", value: `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`, color: pnlColor, icon: "〜" },
        ].map(({ label, value, color, icon }, idx) => (
          <div key={label} style={{
            padding: "7px 6px", textAlign: "center",
            borderRight: idx < 2 ? `1px solid ${C.cardBdr}` : "none",
          }}>
            <p style={{
              color: C.sub, fontSize: "0.5rem", letterSpacing: "0.08em",
              textTransform: "uppercase", margin: "0 0 3px", fontFamily: FONT_UI,
            }}>
              {icon} {label}
            </p>
            <p style={{
              color, fontSize: "0.75rem", fontWeight: 700,
              fontFamily: FONT_MONO, margin: 0,
              textShadow: color !== C.label && color !== C.sub ? `0 0 6px ${color}40` : "none",
            }}>
              {value}
            </p>
          </div>
        ))}
      </div>

      {/* ── 5. TIMESTAMPS — compact single-line format ───────────────────── */}
      <div style={{ padding: "7px 12px 8px", display: "flex", flexDirection: "column", gap: 4 }}>

        {/* Opened */}
        {openDt && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              width: 22, height: 22, borderRadius: 6, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "0.65rem",
              background: "rgba(255,255,255,0.04)", border: `1px solid ${C.cardBdr}`,
            }}>📂</span>
            <div style={{ minWidth: 0 }}>
              <span style={{ color: C.sub, fontSize: "0.52rem", letterSpacing: "0.08em",
                textTransform: "uppercase", marginRight: 5, fontFamily: FONT_UI }}>
                Opened
              </span>
              <span style={{ color: C.label, fontSize: "0.68rem", fontFamily: FONT_MONO }}>
                {fmtStamp(openDt)}
              </span>
            </div>
          </div>
        )}

        {/* Closed (history only) */}
        {isHistory && closeDt && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              width: 22, height: 22, borderRadius: 6, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "0.65rem",
              background: pnl >= 0 ? "rgba(0,255,65,0.08)" : "rgba(255,58,58,0.08)",
              border: `1px solid ${pnl >= 0 ? C.greenBdr : "rgba(255,58,58,0.25)"}`,
            }}>
              {pnl >= 0 ? "✅" : "🔒"}
            </span>
            <div style={{ minWidth: 0 }}>
              <span style={{ color: C.sub, fontSize: "0.52rem", letterSpacing: "0.08em",
                textTransform: "uppercase", marginRight: 5, fontFamily: FONT_UI }}>
                Closed
              </span>
              <span style={{ color: C.label, fontSize: "0.68rem", fontFamily: FONT_MONO }}>
                {fmtStamp(closeDt)}
              </span>
            </div>
          </div>
        )}

        {/* Duration pill + Trade ID — same row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 1 }}>
          {durationMs && (
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              padding: "2px 8px", borderRadius: 99,
              fontSize: "0.6rem", fontWeight: 600, fontFamily: FONT_MONO,
              color: C.label, background: "rgba(255,255,255,0.04)",
              border: `1px solid ${C.cardBdr}`, letterSpacing: "0.04em",
            }}>
              ⏱ {formatDuration(durationMs)}
            </span>
          )}
          {t.id && (
            <span style={{ color: C.sub, fontSize: "0.55rem", fontFamily: FONT_MONO }}>
              ID: {t.id}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Duration formatter ─────────────────────────────────────────────────────────
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const days    = Math.floor(totalSeconds / 86400);
  const hours   = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0)    return `${days}d ${hours}h`;
  if (hours > 0)   return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}