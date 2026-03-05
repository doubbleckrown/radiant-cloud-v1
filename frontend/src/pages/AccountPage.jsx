/**
 * AccountPage — Dual-Engine
 * ══════════════════════════════════════════════════════════════════════════════
 * FOREX mode  → Oanda v20  (account / trades / history)
 * CRYPTO mode → Bybit Account  (bybit/account · bybit/account/positions · bybit/account/history)
 *
 * Architecture rules:
 *  • OANDA state  (account, trades, history, sparklinePoints) is NEVER mutated
 *    in CRYPTO mode.
 *  • Bybit state  (bybitAccount, bybitPositions, bybitHistory, bybitSparkline)
 *    is NEVER mutated in FOREX mode.
 *  • loadOandaXxx() and loadBybitXxx() are fully separate functions — no
 *    nested if/else mixing the two engines.
 *  • All Bybit requests include X-App-Mode: CRYPTO header.
 *  • normalizeTrade(t, isCrypto, kind) maps both trade shapes to a common schema
 *    so TradeDetailCard has zero mode-specific branches in its render.
 *  • Strict null-checks on every Bybit field to prevent black-screen crashes.
 *
 * Backend routes:
 *   Oanda: GET /api/account, /api/account/trades, /api/account/history
 *   Bybit: GET /api/bybit/account, /api/bybit/account/positions, /api/bybit/account/history
 */
import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence }           from "framer-motion";
import api                                   from "../utils/api";
import { useAuthStore }                      from "../store/authStore";
import { useTheme }                          from "../hooks/useTheme";

// ── Non-accent colour tokens (same in both modes) ─────────────────────────────
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

// Inject close-button spin animation once
if (typeof document !== "undefined" && !document.getElementById("acct-spin-css")) {
  const s = document.createElement("style");
  s.id = "acct-spin-css";
  s.textContent = "@keyframes spin { to { transform: rotate(360deg); } }";
  document.head.appendChild(s);
}

const TABS = ["Summary", "Open Trades", "History"];

// ── Bybit API headers ─────────────────────────────────────────────────────────
const BYBIT_HEADERS = { "X-App-Mode": "CRYPTO" };

// ═════════════════════════════════════════════════════════════════════════════
export default function AccountPage() {
  // Private Bot Mode: credentials are .env-only — no per-user credential fetch
  const { isCrypto, accent, accentDim, accentBdr } = useTheme();
  // authStore: mode only in private bot mode

  const [toggling,    setToggling]    = useState(false);

  const [activeTab, setActiveTab] = useState("Summary");
  const [loading,   setLoading]   = useState({});
  const [errors,    setErrors]    = useState({});

  // ── OANDA engine state (never mutated in CRYPTO mode) ─────────────────────
  const [account,         setAccount]         = useState(null);
  const [trades,          setTrades]          = useState([]);
  const [history,         setHistory]         = useState([]);
  const [historyCursor,   setHistoryCursor]   = useState(null);   // beforeID for next page
  const [historyExhausted,setHistoryExhausted]= useState(false);  // true = no more pages
  const [loadingMore,     setLoadingMore]     = useState(false);
  const [sparklinePoints, setSparklinePoints] = useState([]);

  // ── Bybit engine state (never mutated in FOREX mode) ──────────────────────
  const [bybitAccount,   setBybitAccount]   = useState(null);
  const [bybitPositions, setBybitPositions] = useState([]);
  const [bybitHistory,   setBybitHistory]   = useState([]);
  const [bybitSparkline, setBybitSparkline] = useState([]);

  // ── Init ──────────────────────────────────────────────────────────────────
  // No fetchMe needed — Private Bot Mode uses .env credentials only

  // ── OANDA: eagerly load history for the header sparkline (FOREX) ──────────
  useEffect(() => {
    api.get("/account/history?fetch_all=true&count=500")
      .then(({ data }) => {
        if (!Array.isArray(data) || data.length === 0) return;
        const sorted = [...data].sort(
          (a, b) => new Date(a.closeTime ?? 0) - new Date(b.closeTime ?? 0)
        );
        let running = 0;
        const pts = sorted.map(t => {
          running += parseFloat(t.realizedPL ?? 0);
          return running;
        });
        setSparklinePoints(pts);
        setHistory(data);
      })
      .catch(() => {});
  }, []); // eslint-disable-line

  // ── Bybit: eagerly load history for sparkline when entering CRYPTO mode ───
  useEffect(() => {
    if (!isCrypto) return;             // ← isolated: never runs in FOREX mode
    if (bybitHistory.length > 0) return; // already loaded
    api.get("/bybit/account/history", { headers: BYBIT_HEADERS })
      .then(({ data }) => {
        if (!Array.isArray(data) || data.length === 0) return;
        const sorted = [...data].sort(
          (a, b) => parseInt(a.createdTime ?? 0) - parseInt(b.createdTime ?? 0)
        );
        let running = 0;
        const pts = sorted.map(t => {
          running += parseFloat(t.closedPnl ?? t.closedPnl ?? 0);
          return running;
        });
        setBybitSparkline(pts);
        setBybitHistory(data);
      })
      .catch(() => {});
  }, [isCrypto]); // eslint-disable-line

  // ── Reset to Summary tab whenever mode switches ────────────────────────────
  useEffect(() => {
    setActiveTab("Summary");
  }, [isCrypto]);

  // ── Load correct data for the active tab and mode ─────────────────────────
  useEffect(() => {
    if (!isCrypto) {
      // OANDA engine
      if (activeTab === "Summary"     && !account)       loadOandaSummary();
      if (activeTab === "Open Trades" && !trades.length) loadOandaTrades();
      if (activeTab === "History"     && !history.length) loadOandaHistory();
    } else {
      // Bybit engine
      if (activeTab === "Summary"     && !bybitAccount)            loadBybitAccount();
      if (activeTab === "Open Trades" && !bybitPositions.length)   loadBybitPositions();
      if (activeTab === "History"     && !bybitHistory.length)     loadBybitHistory();
    }
  }, [activeTab, isCrypto]); // eslint-disable-line

  // ── Helpers ───────────────────────────────────────────────────────────────
  const mark = (tab, isLoading, err = null) => {
    setLoading(p => ({ ...p, [tab]: isLoading }));
    setErrors( p => ({ ...p, [tab]: err }));
  };

  // ── OANDA load functions (UNCHANGED behaviour, renamed for clarity) ────────
  const loadOandaSummary = useCallback(async () => {
    mark("Summary", true);
    try   { const { data } = await api.get("/account"); setAccount(data); mark("Summary", false); }
    catch (e) { mark("Summary", false, e.userMessage ?? "Could not load account"); }
  }, []);

  const loadOandaTrades = useCallback(async () => {
    mark("Open Trades", true);
    try   { const { data } = await api.get("/account/trades"); setTrades(data ?? []); mark("Open Trades", false); }
    catch (e) { mark("Open Trades", false, e.userMessage ?? "Could not load trades"); }
  }, []);

  const loadOandaHistory = useCallback(async () => {
    mark("History", true);
    try {
      // fetch_all=true (default) — server paginates automatically and returns
      // everything up to 2,000 trades in one shot.
      const { data } = await api.get("/account/history?fetch_all=true&count=500");
      const trades   = data ?? [];
      setHistory(trades);
      // If exactly 2000 came back the server hit its cap — there may be more.
      // Store the oldest trade ID as cursor so "Load More" can fetch the next page.
      if (trades.length >= 2000) {
        setHistoryCursor(trades[trades.length - 1]?.id ?? null);
        setHistoryExhausted(false);
      } else {
        setHistoryCursor(null);
        setHistoryExhausted(true);
      }
      mark("History", false);
    } catch (e) {
      mark("History", false, e.userMessage ?? "Could not load history");
    }
  }, []);

  const loadMoreOandaHistory = useCallback(async () => {
    if (!historyCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const { data } = await api.get(
        `/account/history?fetch_all=true&count=500&before_id=${historyCursor}`
      );
      const next = data ?? [];
      setHistory(prev => [...prev, ...next]);
      if (next.length >= 2000) {
        setHistoryCursor(next[next.length - 1]?.id ?? null);
        setHistoryExhausted(false);
      } else {
        setHistoryCursor(null);
        setHistoryExhausted(true);
      }
    } catch { /* silently ignore — already showing existing history */ }
    finally { setLoadingMore(false); }
  }, [historyCursor, loadingMore]);

  // ── Real-time P&L: silently re-fetch open positions every 5 s ─────────────
  // No loading spinner — just updates `unrealizedPL` / `unrealisedPnl` in state.
  const liveTradesPollRef = useRef(null);

  const refreshLiveOandaTrades = useCallback(async () => {
    try {
      const { data } = await api.get("/account/trades");
      if (Array.isArray(data)) setTrades(data);
    } catch { /* silently ignore — stale data is fine */ }
  }, []);

  const refreshLiveBybitPositions = useCallback(async () => {
    try {
      const { data } = await api.get("/bybit/account/positions", { headers: BYBIT_HEADERS });
      if (Array.isArray(data)) setBybitPositions(data);
    } catch { /* silently ignore */ }
  }, []);

  // Start/stop live P&L polling whenever "Open Trades" tab is active
  useEffect(() => {
    if (activeTab !== "Open Trades") {
      if (liveTradesPollRef.current) {
        clearInterval(liveTradesPollRef.current);
        liveTradesPollRef.current = null;
      }
      return;
    }
    const refresh = isCrypto ? refreshLiveBybitPositions : refreshLiveOandaTrades;
    // Immediate refresh when tab opens, then every 5 seconds
    refresh();
    liveTradesPollRef.current = setInterval(refresh, 5_000);
    return () => {
      if (liveTradesPollRef.current) {
        clearInterval(liveTradesPollRef.current);
        liveTradesPollRef.current = null;
      }
    };
  }, [activeTab, isCrypto, refreshLiveOandaTrades, refreshLiveBybitPositions]);

  // ── Bybit load functions ─────────────────────────────────────────────────
  const loadBybitAccount = useCallback(async () => {
    mark("Summary", true);
    try {
      const { data } = await api.get("/bybit/account", { headers: BYBIT_HEADERS });
      setBybitAccount(data ?? {});
      mark("Summary", false);
    } catch (e) {
      const rawDetail = e?.response?.data?.detail;
      const detail = typeof rawDetail === "string" ? rawDetail
        : typeof rawDetail === "object" && rawDetail !== null
          ? (rawDetail.detail ?? rawDetail.error ?? JSON.stringify(rawDetail))
          : (e?.message ?? "Unknown error");
      mark("Summary", false, `Bybit API Unavailable — ${detail}`);
    }
  }, []);

  const loadBybitPositions = useCallback(async () => {
    mark("Open Trades", true);
    try {
      const { data } = await api.get("/bybit/account/positions", { headers: BYBIT_HEADERS });
      setBybitPositions(Array.isArray(data) ? data : []);
      mark("Open Trades", false);
    } catch (e) {
      const rawDetail = e?.response?.data?.detail;
      const detail = typeof rawDetail === "string" ? rawDetail
        : typeof rawDetail === "object" && rawDetail !== null
          ? (rawDetail.detail ?? rawDetail.error ?? JSON.stringify(rawDetail))
          : (e?.message ?? "Unknown error");
      mark("Open Trades", false, `Bybit API Unavailable — ${detail}`);
    }
  }, []);

  const loadBybitHistory = useCallback(async () => {
    mark("History", true);
    try {
      const { data } = await api.get("/bybit/account/history", { headers: BYBIT_HEADERS });
      setBybitHistory(Array.isArray(data) ? data : []);
      mark("History", false);
    } catch (e) {
      const rawDetail = e?.response?.data?.detail;
      const detail = typeof rawDetail === "string" ? rawDetail
        : typeof rawDetail === "object" && rawDetail !== null
          ? (rawDetail.detail ?? rawDetail.error ?? JSON.stringify(rawDetail))
          : (e?.message ?? "Unknown error");
      mark("History", false, `Bybit API Unavailable — ${detail}`);
    }
  }, []);

  // ── Trade close (manual) ─────────────────────────────────────────────────
  const [closing,    setClosing]    = useState({});  // {tradeId: true}
  const [closeError, setCloseError] = useState(null);

  const closeTrade = useCallback(async ({ tradeId, symbol, side, qty }) => {
    const key = tradeId ?? symbol;
    setClosing(p => ({ ...p, [key]: true }));
    setCloseError(null);
    try {
      if (isCrypto) {
        await api.post("/trade/close", { broker: "bybit", symbol, side, qty: String(qty) });
        // Optimistically remove from local state
        setBybitPositions(ps => ps.filter(p => p.symbol !== symbol));
      } else {
        await api.post("/trade/close", { broker: "oanda", trade_id: String(tradeId) });
        setTrades(ts => ts.filter(t => String(t.id) !== String(tradeId)));
      }
    } catch (e) {
      const rawMsg = e?.response?.data?.detail;
      const msg = typeof rawMsg === "string" ? rawMsg
        : typeof rawMsg === "object" && rawMsg !== null
          ? (rawMsg.detail ?? rawMsg.error ?? JSON.stringify(rawMsg))
          : (e?.message ?? "Close failed — try again");
      setCloseError(msg);
      setTimeout(() => setCloseError(null), 4000);
    } finally {
      setClosing(p => { const n = { ...p }; delete n[key]; return n; });
    }
  }, [isCrypto]);



  // ── Active state (routed by mode) ─────────────────────────────────────────
  const activeAccount   = isCrypto ? bybitAccount   : account;
  const activeTrades    = isCrypto ? bybitPositions  : trades;
  const activeHistory   = isCrypto ? bybitHistory    : history;
  const activeSparkline = isCrypto ? bybitSparkline  : sparklinePoints;

  const retryFns = {
    Summary:      isCrypto ? loadBybitAccount    : loadOandaSummary,
    "Open Trades": isCrypto ? loadBybitPositions  : loadOandaTrades,
    History:      isCrypto ? loadBybitHistory    : loadOandaHistory,
  };

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
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1 style={{
              color: C.white, fontSize: "1.2rem", fontWeight: 700,
              letterSpacing: "0.03em", margin: 0, fontFamily: FONT_UI,
            }}>
              {isCrypto ? "Bybit Account" : "Account"}
            </h1>
            <p style={{ color: C.label, fontSize: "0.7rem", margin: "2px 0 0", fontFamily: FONT_UI }}>
              {isCrypto ? "Bybit V5 · Linear Perpetuals" : "Oanda v20 · Live data"}
            </p>
          </div>

          {/* Balance Sparkline */}
          {activeSparkline.length > 1 && (
            <BalanceSparkline points={activeSparkline} accent={accent} />
          )}

          {/* LIVE badge */}
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "6px 12px", borderRadius: 99,
            background: accentDim, border: `1px solid ${accentBdr}`,
          }}>
            <motion.div
              animate={{ opacity: [1, 0.25, 1] }}
              transition={{ duration: 1.4, repeat: Infinity }}
              style={{ width: 6, height: 6, borderRadius: "50%", background: accent }}
            />
            <span style={{
              color: accent, fontSize: "0.65rem", fontWeight: 700,
              letterSpacing: "0.1em", fontFamily: FONT_UI,
            }}>LIVE</span>
          </div>
        </div>
      </div>

      {/* ── Content ────────────────────────────────────────────────────── */}
      <div style={{ padding: "16px 16px 32px", display: "flex", flexDirection: "column", gap: 12 }}>

        {/* AUTO-TRADE TOGGLE — Oanda only; Bybit auto-trading */}
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
                  background: active ? accentDim : "transparent",
                  color:      active ? accent    : C.label,
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
                      background: accent,
                      boxShadow: `0 0 8px ${accent}`,
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
            key={activeTab + (isCrypto ? "-crypto" : "-forex")}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
          >
            {activeTab === "Summary" && (
              <SummaryTab
                account={activeAccount}
                loading={loading.Summary}
                error={errors.Summary}
                onRetry={retryFns.Summary}
                isCrypto={isCrypto}
                accent={accent}
                accentDim={accentDim}
                accentBdr={accentBdr}
              />
            )}
            {activeTab === "Open Trades" && (
              <OpenTradesTab
                trades={activeTrades}
                loading={loading["Open Trades"]}
                error={errors["Open Trades"]}
                onRetry={retryFns["Open Trades"]}
                isCrypto={isCrypto}
                accent={accent}
                closing={closing}
                closeError={closeError}
                onClose={closeTrade}
              />
            )}
            {activeTab === "History" && (
              <HistoryTab
                history={activeHistory}
                loading={loading.History}
                error={errors.History}
                onRetry={retryFns.History}
                isCrypto={isCrypto}
                accent={accent}
                onLoadMore={!isCrypto && !historyExhausted ? loadMoreOandaHistory : null}
                loadingMore={!isCrypto && loadingMore}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  BalanceSparkline — accepts an `accent` prop so the line colour matches mode
// ─────────────────────────────────────────────────────────────────────────────
function BalanceSparkline({ points, accent }) {
  const W = 88, H = 32;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;

  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * W;
    const y = H - 4 - ((p - min) / range) * (H - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const pathD   = "M" + coords.join(" L");
  const lastPnl = points[points.length - 1];
  const color   = lastPnl >= 0 ? C.green : C.red;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ overflow: "visible" }}>
        {min < 0 && max > 0 && (
          <line
            x1="0" y1={H - 4 - ((-min) / range) * (H - 8)}
            x2={W} y2={H - 4 - ((-min) / range) * (H - 8)}
            stroke="rgba(255,255,255,0.08)" strokeWidth="1" strokeDasharray="3,3"
          />
        )}
        <path
          d={pathD} fill="none" stroke={color} strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round"
          style={{ filter: `drop-shadow(0 0 3px ${color}80)` }}
        />
        <circle
          cx={coords[coords.length - 1].split(",")[0]}
          cy={coords[coords.length - 1].split(",")[1]}
          r="2.5" fill={color}
          style={{ filter: `drop-shadow(0 0 4px ${color})` }}
        />
      </svg>
      <span style={{
        color: C.sub, fontSize: "0.55rem",
        fontFamily: FONT_MONO, letterSpacing: "0.06em",
      }}>
        {lastPnl >= 0 ? "+" : ""}{lastPnl.toFixed(2)} P&L
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────


function TabLoading() {
  const { accent } = useTheme();
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "64px 0" }}>
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
        style={{
          width: 32, height: 32, borderRadius: "50%",
          border: "2px solid transparent", borderTopColor: accent,
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
      <p style={{
        color: C.red, fontSize: "0.82rem", fontWeight: 600,
        margin: "0 0 6px", fontFamily: FONT_UI,
      }}>Connection Error</p>
      <p style={{
        color: C.label, fontSize: "0.72rem", lineHeight: 1.5,
        margin: 0, fontFamily: FONT_UI,
      }}>{message}</p>
      <button
        onClick={onRetry}
        style={{
          marginTop: 12, padding: "6px 18px", borderRadius: 10,
          background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)",
          color: C.white, fontSize: "0.7rem", letterSpacing: "0.08em",
          cursor: "pointer", fontFamily: FONT_UI,
        }}
      >
        RETRY
      </button>
    </div>
  );
}

function TabEmpty({ icon, title, sub }) {
  const { accentDim, accentBdr } = useTheme();
  return (
    <div style={{
      display: "flex", flexDirection: "column",
      alignItems: "center", padding: "64px 0", gap: 12,
    }}>
      <div style={{
        width: 56, height: 56, borderRadius: "50%",
        background: accentDim, border: `1px solid ${accentBdr}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "1.5rem",
      }}>{icon}</div>
      <div style={{ textAlign: "center" }}>
        <p style={{
          color: C.label, fontSize: "0.8rem", letterSpacing: "0.05em",
          margin: "0 0 4px", fontFamily: FONT_UI,
        }}>{title}</p>
        <p style={{ color: C.sub, fontSize: "0.68rem", margin: 0, fontFamily: FONT_UI }}>{sub}</p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  SummaryTab — Oanda or Bybit Account, selected by isCrypto
// ─────────────────────────────────────────────────────────────────────────────
function SummaryTab({ account, loading, error, onRetry, isCrypto, accent, accentDim, accentBdr }) {
  if (loading) return <TabLoading />;
  if (error)   return <TabError message={error} onRetry={onRetry} />;
  if (!account) return null;

  // ── Bybit Unified Account ──────────────────────────────────────────
  if (isCrypto) {
    const equity    = parseFloat(account.totalEquity          ?? 0);
    const margin    = parseFloat(account.totalMarginBalance    ?? 0);
    const available = parseFloat(account.totalAvailableBalance ?? 0);
    const upl       = parseFloat(account.totalPerpUPL          ?? 0);
    const accType   = typeof account.accountType === "string"
      ? account.accountType : "UNIFIED";

    const stats = [
      { label: "Total Equity",    value: `$${equity.toFixed(2)}` },
      { label: "Margin Balance",  value: `$${margin.toFixed(2)}` },
      { label: "Unrealised P&L",  value: `$${upl.toFixed(2)}`, pnl: true },
      { label: "Available",       value: `$${available.toFixed(2)}` },
      { label: "Margin Used",     value: `$${Math.max(margin - available, 0).toFixed(2)}` },
      { label: "Account Type",    value: accType },
    ];

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Account header card */}
        <div style={{
          padding: 16, borderRadius: 16,
          background: "rgba(0,180,200,0.04)",
          border: `1px solid ${accentBdr}`,
        }}>
          <p style={{
            color: C.label, fontSize: "0.62rem",
            letterSpacing: "0.1em", margin: "0 0 6px", fontFamily: FONT_UI,
          }}>ACCOUNT TYPE</p>
          <p style={{
            color: accent, fontSize: "0.85rem", fontWeight: 700,
            fontFamily: FONT_MONO, margin: "0 0 4px",
          }}>
            {accType}
          </p>
          <p style={{
            color: C.label, fontSize: "0.7rem",
            textTransform: "capitalize", margin: 0, fontFamily: FONT_UI,
          }}>
            Bybit Unified Account
          </p>
        </div>

        {/* Stats grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {stats.map((stat, i) => {
            const pnlVal   = stat.pnl ? parseFloat(stat.value.replace("$", "")) : null;
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
                <p style={{
                  color: C.label, fontSize: "0.6rem",
                  letterSpacing: "0.1em", margin: "0 0 8px", fontFamily: FONT_UI,
                }}>
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

  // ── OANDA account (UNCHANGED layout) ───────────────────────────────────────
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
        <p style={{
          color: C.label, fontSize: "0.62rem",
          letterSpacing: "0.1em", margin: "0 0 6px", fontFamily: FONT_UI,
        }}>ACCOUNT ID</p>
        <p style={{
          color: C.green, fontSize: "0.85rem", fontWeight: 700,
          fontFamily: FONT_MONO, margin: "0 0 4px",
        }}>{account.id}</p>
        <p style={{
          color: C.label, fontSize: "0.7rem",
          textTransform: "capitalize", margin: 0, fontFamily: FONT_UI,
        }}>
          {account.type?.toLowerCase() ?? "—"} account
        </p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {stats.map((stat, i) => {
          const pnlVal   = stat.pnl ? parseFloat(stat.value.replace("$", "")) : null;
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
              <p style={{
                color: C.label, fontSize: "0.6rem",
                letterSpacing: "0.1em", margin: "0 0 8px", fontFamily: FONT_UI,
              }}>
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
//  Open Trades tab — Oanda or Bybit positions, selected by isCrypto
// ─────────────────────────────────────────────────────────────────────────────
function OpenTradesTab({ trades, loading, error, onRetry, isCrypto, accent, closing = {}, closeError, onClose }) {
  const [openId, setOpenId] = useState(null);

  if (loading) return <TabLoading />;
  if (error)   return <TabError message={error} onRetry={onRetry} />;
  if (!trades.length) return (
    <TabEmpty
      icon="📭"
      title="No open positions"
      sub={isCrypto
        ? "Live Bybit positions will appear here"
        : "Live trades will appear here once placed"}
    />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {trades.map((t, i) => {
        // ── Normalize display fields for BOTH engines ──────────────────────
        const norm = isCrypto
          ? {
              id:       t.symbol ?? String(i),
              ins:      typeof t.symbol === "string"
                          ? t.symbol.replace(/USDT$/, "/USDT").replace(/USDC$/, "/USDC")
                          : "—",
              isLong:   (typeof t.side === "string" ? t.side : "") === "Buy",
              units:    Math.abs(parseFloat(t.size ?? t.qty ?? 0)),
              entryFmt: parseFloat(t.avgPrice ?? 0).toFixed(2),
              // Risk Capital = initial margin posted (positionIM), not notional
              risk:     `$${parseFloat(t.positionIM ?? t.positionValue ?? 0).toFixed(2)}`,
              riskLbl:  "Risk Capital",
              pnl:      parseFloat(t.unrealisedPnl ?? t.unrealizedPnl ?? 0),
              openTs:   t.createdTime
                          ? new Date(parseInt(t.createdTime)).toLocaleString()
                          : "—",
            }
          : {
              id:       t.id ?? String(i),
              ins:      (t.instrument ?? "").replace("_", "/"),
              isLong:   parseInt(t.currentUnits ?? t.initialUnits ?? 0) > 0,
              units:    Math.abs(parseInt(t.currentUnits ?? t.initialUnits ?? 0)),
              entryFmt: parseFloat(t.price ?? 0).toFixed(5),
              // Risk Capital = actual margin locked by Oanda for this position
              risk:     `$${parseFloat(t.marginUsed ?? 0).toFixed(2)}`,
              riskLbl:  "Risk Capital",
              pnl:      parseFloat(t.unrealizedPL ?? 0),
              openTs:   t.openTime ? new Date(t.openTime).toLocaleString() : "—",
            };

        const pnlColor = norm.pnl >= 0 ? C.green : C.red;
        const isOpen   = openId === norm.id;

        return (
          <motion.div
            key={norm.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            style={{
              borderRadius: 16, overflow: "hidden",
              background: C.card,
              border: `1px solid ${isOpen
                ? (norm.isLong ? C.greenBdr : "rgba(255,58,58,0.4)")
                : (norm.isLong ? "rgba(0,255,65,0.22)" : "rgba(255,58,58,0.22)")}`,
              boxShadow: isOpen
                ? (norm.isLong ? "0 0 20px rgba(0,255,65,0.07)" : "0 0 20px rgba(255,58,58,0.07)")
                : "none",
            }}
          >
            <div style={{
              height: 2,
              background: norm.isLong
                ? "linear-gradient(90deg, transparent, #00FF41, transparent)"
                : "linear-gradient(90deg, transparent, #FF3A3A, transparent)",
            }} />

            <motion.div
              whileTap={{ scale: 0.99 }}
              onClick={() => setOpenId(isOpen ? null : norm.id)}
              style={{ padding: 14, cursor: "pointer" }}
            >
              <div style={{
                display: "flex", alignItems: "center",
                justifyContent: "space-between", marginBottom: 12,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{
                    color: C.white, fontWeight: 700,
                    fontSize: "0.95rem", fontFamily: FONT_UI,
                  }}>{norm.ins}</span>
                  <span style={{
                    padding: "2px 8px", borderRadius: 6,
                    fontSize: "0.62rem", fontWeight: 700, letterSpacing: "0.07em",
                    color:      norm.isLong ? C.green : C.red,
                    background: norm.isLong ? "rgba(0,255,65,0.12)" : "rgba(255,58,58,0.12)",
                    border:     `1px solid ${norm.isLong ? C.greenBdr : "rgba(255,58,58,0.3)"}`,
                    fontFamily: FONT_UI,
                  }}>
                    {norm.isLong ? "▲ LONG" : "▼ SHORT"}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{
                    color: pnlColor, fontWeight: 700,
                    fontSize: "0.9rem", fontFamily: FONT_MONO,
                  }}>
                    {norm.pnl >= 0 ? "+" : ""}{norm.pnl.toFixed(2)}
                  </span>
                  <motion.div
                    animate={{ rotate: isOpen ? 180 : 0 }}
                    transition={{ duration: 0.2 }}
                    style={{ color: isOpen ? (norm.isLong ? C.green : C.red) : C.sub }}
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
                  { label: "Units",      value: norm.units.toLocaleString() },
                  { label: "Entry",      value: norm.entryFmt },
                  { label: norm.riskLbl, value: norm.risk },
                ].map(({ label, value }) => (
                  <div key={label} style={{
                    padding: "8px 6px", borderRadius: 10, textAlign: "center",
                    background: C.sheet, border: `1px solid ${C.cardBdr}`,
                  }}>
                    <p style={{
                      color: C.label, fontSize: "0.58rem",
                      letterSpacing: "0.08em", margin: "0 0 4px", fontFamily: FONT_UI,
                    }}>
                      {label.toUpperCase()}
                    </p>
                    <p style={{
                      color: C.white, fontSize: "0.72rem",
                      fontWeight: 600, fontFamily: FONT_MONO, margin: 0,
                    }}>
                      {value}
                    </p>
                  </div>
                ))}
              </div>

              <div style={{
                display: "flex", alignItems: "center",
                justifyContent: "space-between", marginTop: 10,
              }}>
                <p style={{ color: C.sub, fontSize: "0.62rem", margin: 0, fontFamily: FONT_UI }}>
                  Opened {norm.openTs}
                </p>
                <CloseTradeButton
                  isLoading={closing[norm.id] || closing[norm.symbol]}
                  onClose={() => onClose(isCrypto
                    ? { symbol: t.symbol, side: t.side, qty: t.size ?? t.qty ?? "0" }
                    : { tradeId: t.id }
                  )}
                />
              </div>
              {closeError && (
                <p style={{
                  color: C.red, fontSize: "0.62rem", margin: "4px 0 0",
                  fontFamily: FONT_UI,
                }}>
                  ⚠ {closeError}
                </p>
              )}
            </motion.div>

            {/* Accordion: Trade Detail Card */}
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}
                  style={{ overflow: "hidden" }}
                >
                  <TradeDetailCard trade={t} kind="open" isCrypto={isCrypto} />
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
//  CloseTradeButton — red close button with loading spinner
// ─────────────────────────────────────────────────────────────────────────────
function CloseTradeButton({ onClose, isLoading }) {
  return (
    <motion.button
      whileTap={{ scale: 0.96 }}
      disabled={isLoading}
      onClick={e => { e.stopPropagation(); onClose(); }}
      style={{
        display:       "flex",
        alignItems:    "center",
        gap:           5,
        padding:       "5px 12px",
        borderRadius:  8,
        border:        "1px solid rgba(255,58,58,0.4)",
        background:    isLoading ? "rgba(255,58,58,0.05)" : "rgba(255,58,58,0.1)",
        color:         isLoading ? "#666" : "#FF3A3A",
        fontSize:      "0.65rem",
        fontWeight:    700,
        fontFamily:    "'Inter', sans-serif",
        letterSpacing: "0.06em",
        cursor:        isLoading ? "not-allowed" : "pointer",
        transition:    "all 0.15s",
        whiteSpace:    "nowrap",
        boxShadow:     isLoading ? "none" : "0 0 10px rgba(255,58,58,0.15)",
      }}
    >
      {isLoading ? (
        <>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            style={{ animation: "spin 0.8s linear infinite" }}>
            <path d="M12 2a10 10 0 0 1 0 20"/>
          </svg>
          CLOSING…
        </>
      ) : (
        <>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
          CLOSE TRADE
        </>
      )}
    </motion.button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  History tab — Oanda or Bybit closed trades, selected by isCrypto
// ─────────────────────────────────────────────────────────────────────────────
function HistoryTab({ history, loading, error, onRetry, isCrypto, accent, onLoadMore, loadingMore }) {
  const [openId, setOpenId] = useState(null);

  if (loading) return <TabLoading />;
  if (error)   return <TabError message={error} onRetry={onRetry} />;
  if (!history.length) return (
    <TabEmpty
      icon="📜"
      title="No closed trades"
      sub={isCrypto
        ? "Your Bybit trade history will appear here"
        : "Your trade history will appear here"}
    />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {history.map((t, i) => {
        // ── Normalize display fields ───────────────────────────────────────
        const norm = isCrypto
          ? {
              id:       t.orderId ?? t.tradeId ?? String(i),
              ins:      typeof t.symbol === "string"
                          ? t.symbol.replace(/USDT$/, "/USDT").replace(/USDC$/, "/USDC")
                          : "—",
              isLong:   (typeof t.side === "string" ? t.side : "") === "Buy",
              units:    Math.abs(parseFloat(t.qty ?? t.size ?? 0)),
              pnl:      parseFloat(t.closedPnl ?? t.realizedPnl ?? 0),
              closeDateStr: t.updatedTime
                              ? new Date(parseInt(t.updatedTime)).toLocaleDateString()
                              : "—",
            }
          : {
              id:       t.id ?? String(i),
              ins:      (t.instrument ?? "").replace("_", "/"),
              isLong:   parseInt(t.initialUnits ?? 0) > 0,
              units:    Math.abs(parseInt(t.initialUnits ?? 0)),
              pnl:      parseFloat(t.realizedPL ?? 0),
              closeDateStr: t.closeTime
                              ? new Date(t.closeTime).toLocaleDateString()
                              : "—",
            };

        const pnlColor = norm.pnl >= 0 ? C.green : C.red;
        const isOpen   = openId === norm.id;

        return (
          <motion.div
            key={norm.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.03, 0.3) }}
            style={{
              borderRadius: 14, overflow: "hidden",
              background: C.card,
              border: `1px solid ${isOpen
                ? (norm.pnl >= 0 ? C.greenBdr : "rgba(255,58,58,0.4)")
                : C.cardBdr}`,
              boxShadow: isOpen ? `0 0 16px ${pnlColor}10` : "none",
            }}
          >
            <motion.div
              whileTap={{ scale: 0.99 }}
              onClick={() => setOpenId(isOpen ? null : norm.id)}
              style={{
                display: "flex", alignItems: "center",
                gap: 12, padding: "12px 14px", cursor: "pointer",
              }}
            >
              <div style={{
                width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                background: norm.isLong ? C.green : C.red,
                boxShadow: `0 0 6px ${norm.isLong ? C.green : C.red}`,
              }} />

              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{
                  color: C.white, fontSize: "0.88rem",
                  fontWeight: 600, margin: "0 0 3px", fontFamily: FONT_UI,
                }}>{norm.ins}</p>
                <p style={{ color: C.sub, fontSize: "0.62rem", margin: 0, fontFamily: FONT_UI }}>
                  {norm.isLong ? "Long" : "Short"} · {norm.units.toLocaleString()} {isCrypto ? "qty" : "units"}
                </p>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ textAlign: "right" }}>
                  <p style={{
                    color: pnlColor, fontSize: "0.9rem", fontWeight: 700,
                    fontFamily: FONT_MONO,
                    textShadow: `0 0 6px ${pnlColor}60`, margin: "0 0 3px",
                  }}>
                    {norm.pnl >= 0 ? "+" : ""}{norm.pnl.toFixed(2)}
                  </p>
                  <p style={{ color: C.sub, fontSize: "0.6rem", margin: 0, fontFamily: FONT_UI }}>
                    {norm.closeDateStr}
                  </p>
                </div>
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

            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}
                  style={{ overflow: "hidden" }}
                >
                  <TradeDetailCard trade={t} kind="history" isCrypto={isCrypto} />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        );
      })}
      {/* ── Load More — shown only for Oanda when more pages exist ──────── */}
      {onLoadMore && (
        <div style={{ display: "flex", justifyContent: "center", padding: "16px 0 4px" }}>
          <button
            onClick={onLoadMore}
            disabled={loadingMore}
            style={{
              padding: "10px 28px", borderRadius: 12, cursor: loadingMore ? "not-allowed" : "pointer",
              background: loadingMore ? "rgba(255,255,255,0.04)" : `${accent}0f`,
              border: `1px solid ${loadingMore ? "rgba(255,255,255,0.1)" : `${accent}35`}`,
              color: loadingMore ? "#555" : accent,
              fontSize: "0.75rem", fontWeight: 700, fontFamily: "'Inter', sans-serif",
              display: "flex", alignItems: "center", gap: 8, transition: "all 0.2s",
            }}
          >
            {loadingMore ? (
              <>
                <span style={{
                  width: 12, height: 12, borderRadius: "50%",
                  border: "2px solid transparent", borderTopColor: accent,
                  display: "inline-block", animation: "spin 0.6s linear infinite",
                }} />
                Loading…
              </>
            ) : "Load older trades"}
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  normalizeTrade — maps both Oanda and Bybit trade shapes to a common schema.
//  All Bybit fields are parsed with strict null-checks to prevent crashes if
//  the backend returns missing or differently-named keys.
// ─────────────────────────────────────────────────────────────────────────────
function normalizeTrade(t, isCrypto, kind) {
  const isHistory = kind === "history";

  if (!isCrypto) {
    // ── OANDA ─────────────────────────────────────────────────────────────
    const rawUnits = parseInt(
      isHistory ? (t.initialUnits ?? 0) : (t.currentUnits ?? t.initialUnits ?? 0)
    );
    const pnl = parseFloat(
      isHistory ? (t.realizedPL ?? 0) : (t.unrealizedPL ?? 0)
    );
    const financing  = parseFloat(t.financing  ?? 0);
    const commission = parseFloat(t.commission ?? 0);
    const margin     = parseFloat(t.marginUsed ?? 0);

    const slPxOanda  = parseFloat(t.stopLossPrice   ?? t.stopLossOrder?.price  ?? t.stopLossOrderID  ?? 0);
    const tpPxOanda  = parseFloat(t.takeProfitPrice ?? t.takeProfitOrder?.price ?? t.takeProfitOrderID ?? 0);
    const slUsdOanda = parseFloat(t.slAmountUSD ?? 0);
    const tpUsdOanda = parseFloat(t.tpAmountUSD ?? 0);

    return {
      instrument: (t.instrument ?? "").replace("_", "/"),
      isLong:     rawUnits > 0,
      units:      Math.abs(rawUnits),
      pnl,
      pnlLabel:   isHistory ? "Realized P&L" : "Unrealized P&L",
      entryPx:    parseFloat(t.price ?? 0),
      closePx:    parseFloat(t.averageClosePrice ?? 0),
      slPx:       slPxOanda,
      tpPx:       tpPxOanda,
      slUsd:      isHistory ? 0 : slUsdOanda,
      tpUsd:      isHistory ? 0 : tpUsdOanda,
      riskAmt:    isHistory ? Math.abs(financing + commission) : margin,
      riskLabel:  isHistory ? "Fees & Fin." : "Risk Capital",
      conflTitle: rawUnits > 0 ? "SMC Bullish Order Block" : "SMC Bearish Order Block",
      conflSub:   rawUnits > 0
        ? "Demand Zone · Above 200 EMA · CHoCH confirmed"
        : "Supply Zone · Below 200 EMA · CHoCH confirmed",
      openDt:  t.openTime  ? new Date(t.openTime)  : null,
      closeDt: t.closeTime ? new Date(t.closeTime) : null,
      id:      t.id ?? null,
      engine:  "oanda",
    };
  }

  // ── Bybit — strict null-checks on every field ────────────────────────────
  const side   = typeof t.side === "string" ? t.side : "";
  const isLong = side === "Buy";
  const sym    = typeof t.symbol === "string"
    ? t.symbol.replace(/USDT$/, "/USDT").replace(/USDC$/, "/USDC")
    : "—";

  if (isHistory) {
    // Bybit closed trade record
    const qty       = Math.abs(parseFloat(t.qty    ?? t.size ?? 0));
    const closedPnl = parseFloat(t.closedPnl ?? t.realizedPnl ?? 0);
    const entryPx   = parseFloat(t.avgEntryPrice ?? t.price ?? 0);
    const exitPx    = parseFloat(t.avgExitPrice  ?? t.closedPrice ?? 0);
    const openMs    = parseInt(t.createdTime ?? t.openTime  ?? 0);
    const closeMs   = parseInt(t.updatedTime ?? t.closeTime ?? 0);

    return {
      instrument: sym,
      isLong,
      units:      qty,
      pnl:        closedPnl,
      pnlLabel:   "Realized P&L",
      entryPx,
      closePx:    exitPx,
      slPx:       0,    // Bybit closed trade records don't carry SL/TP
      tpPx:       0,
      riskAmt:    parseFloat(t.closingFee ?? t.commission ?? 0),
      riskLabel:  "Closing Fee",
      conflTitle: isLong ? "Bybit Long Position" : "Bybit Short Position",
      conflSub:   sym + (isLong ? " · Long · Closed" : " · Short · Closed"),
      openDt:     openMs  > 0 ? new Date(openMs)  : null,
      closeDt:    closeMs > 0 ? new Date(closeMs) : null,
      id:         t.orderId ?? t.tradeId ?? null,
      engine:     "bybit",
    };
  }

  // Bybit open position
  const size      = Math.abs(parseFloat(t.size      ?? t.qty           ?? 0));
  const unrealPnl = parseFloat(t.unrealisedPnl ?? t.unrealizedPnl   ?? 0);
  const avgPrice  = parseFloat(t.avgPrice       ?? t.entryPrice       ?? 0);
  const posVal    = parseFloat(t.positionValue   ?? t.posValue         ?? 0);
  const slPx      = parseFloat(t.stopLoss        ?? 0);
  const tpPx      = parseFloat(t.takeProfit      ?? 0);
  const openMs    = parseInt(t.createdTime        ?? t.openTime         ?? 0);

  const posIM   = parseFloat(t.positionIM ?? 0);
  const slUsd   = parseFloat(t.slAmountUSD ?? 0);
  const tpUsd   = parseFloat(t.tpAmountUSD ?? 0);

  return {
    instrument: sym,
    isLong,
    units:      size,
    pnl:        unrealPnl,
    pnlLabel:   "Unrealized P&L",
    entryPx:    avgPrice,
    closePx:    0,
    slPx,
    tpPx,
    slUsd,
    tpUsd,
    riskAmt:    posIM > 0 ? posIM : posVal,
    riskLabel:  "Risk Capital",
    conflTitle: isLong ? "Bybit Long Position" : "Bybit Short Position",
    conflSub:   sym + (isLong ? " · Long · Live" : " · Short · Live"),
    openDt:     openMs > 0 ? new Date(openMs) : null,
    closeDt:    null,
    id:         t.positionIdx != null ? String(t.positionIdx) : t.symbol ?? null,
    engine:     "bybit",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  TradeDetailCard — compact accordion panel · mobile-first
//  Handles BOTH Oanda and Bybit trade shapes via normalizeTrade().
//  The render section below is engine-agnostic: it only uses `norm.*` fields.
// ─────────────────────────────────────────────────────────────────────────────
function TradeDetailCard({ trade: t, kind, isCrypto = false }) {
  const norm      = normalizeTrade(t, isCrypto, kind);
  const isHistory = kind === "history";

  const {
    instrument, isLong, units, pnl, pnlLabel,
    entryPx, closePx, slPx, tpPx, slUsd, tpUsd, riskAmt, riskLabel,
    conflTitle, conflSub, openDt, closeDt, id,
  } = norm;

  const pnlColor = pnl >= 0 ? C.green : C.red;
  const pnlSign  = pnl >= 0 ? "+" : "";
  const dirColor = isLong ? C.green : C.red;

  const durationMs = openDt && closeDt ? closeDt - openDt : null;

  const fmtStamp = (d) => d
    ? d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "2-digit" }) +
      " · " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "—";

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

      {/* ── 1. BANNER ───────────────────────────────────────────────────── */}
      <div style={{
        display:      "flex",
        alignItems:   "center",
        gap:          10,
        padding:      "8px 12px",
        borderBottom: `1px solid ${C.cardBdr}`,
        background:   isLong ? "rgba(0,255,65,0.03)" : "rgba(255,58,58,0.03)",
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: 9, flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "1rem",
          background: isLong ? "rgba(0,255,65,0.1)" : "rgba(255,58,58,0.1)",
          border: `1px solid ${isLong ? C.greenBdr : "rgba(255,58,58,0.3)"}`,
        }}>
          {isCrypto ? (isLong ? "₿" : "₿") : (isLong ? "📈" : "📉")}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
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
              color:       C.amber,
              background:  "rgba(255,184,0,0.1)",
              border:      "1px solid rgba(255,184,0,0.28)", fontFamily: FONT_UI,
            }}>{isCrypto ? "Bybit" : "SMC/ICT"}</span>
            <span style={{
              padding: "1px 5px", borderRadius: 4, fontSize: "0.52rem",
              fontWeight: 700, letterSpacing: "0.08em",
              color:      dirColor,
              background: isLong ? "rgba(0,255,65,0.1)" : "rgba(255,58,58,0.1)",
              border:     `1px solid ${isLong ? C.greenBdr : "rgba(255,58,58,0.3)"}`,
              fontFamily: FONT_UI,
            }}>
              {isLong ? "▲ LONG" : "▼ SHORT"}
            </span>
          </div>
          <p style={{
            color: C.sub, fontSize: "0.6rem", margin: 0,
            fontFamily: FONT_UI, lineHeight: 1.3,
          }}>
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
          { label: "Units",     value: units.toLocaleString(),                    color: C.white, icon: "◈" },
          { label: "Entry",     value: fmt(entryPx),                              color: C.white, icon: "⤵" },
          { label: riskLabel,   value: riskAmt > 0 ? `$${riskAmt.toFixed(2)}` : "—", color: C.amber, icon: "⚖" },
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

      {/* ── 4. EXECUTION — SL $ · TP $ · Close/Live ───────────────────────── */}
      {/* Open trades: SL/TP show dollar risk/reward with price as sub-label.  */}
      {/* History:     shows close price + realized P&L.                        */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
        borderBottom: `1px solid ${C.cardBdr}`,
      }}>
        {/* SL cell */}
        <div style={{ padding: "7px 6px", textAlign: "center", borderRight: `1px solid ${C.cardBdr}` }}>
          <p style={{ color: C.sub, fontSize: "0.5rem", letterSpacing: "0.08em", textTransform: "uppercase", margin: "0 0 3px", fontFamily: FONT_UI }}>
            🛑 {isHistory ? "Stop Loss" : "SL Risk"}
          </p>
          {!isHistory && slUsd > 0 ? (
            <>
              <p style={{ color: C.red, fontSize: "0.75rem", fontWeight: 700, fontFamily: FONT_MONO, margin: 0, textShadow: `0 0 6px ${C.red}40` }}>
                -${slUsd.toFixed(2)}
              </p>
              {slPx > 0 && (
                <p style={{ color: C.sub, fontSize: "0.52rem", fontFamily: FONT_MONO, margin: "2px 0 0" }}>{fmt(slPx)}</p>
              )}
            </>
          ) : (
            <p style={{ color: slPx > 0 ? C.red : C.sub, fontSize: "0.75rem", fontWeight: 700, fontFamily: FONT_MONO, margin: 0 }}>
              {fmt(slPx)}
            </p>
          )}
        </div>

        {/* TP cell */}
        <div style={{ padding: "7px 6px", textAlign: "center", borderRight: `1px solid ${C.cardBdr}` }}>
          <p style={{ color: C.sub, fontSize: "0.5rem", letterSpacing: "0.08em", textTransform: "uppercase", margin: "0 0 3px", fontFamily: FONT_UI }}>
            🎯 {isHistory ? "Take Profit" : "TP Reward"}
          </p>
          {!isHistory && tpUsd > 0 ? (
            <>
              <p style={{ color: C.green, fontSize: "0.75rem", fontWeight: 700, fontFamily: FONT_MONO, margin: 0, textShadow: `0 0 6px ${C.green}40` }}>
                +${tpUsd.toFixed(2)}
              </p>
              {tpPx > 0 && (
                <p style={{ color: C.sub, fontSize: "0.52rem", fontFamily: FONT_MONO, margin: "2px 0 0" }}>{fmt(tpPx)}</p>
              )}
            </>
          ) : (
            <p style={{ color: tpPx > 0 ? C.green : C.sub, fontSize: "0.75rem", fontWeight: 700, fontFamily: FONT_MONO, margin: 0 }}>
              {tpPx > 0 ? fmt(tpPx) : "—"}
            </p>
          )}
        </div>

        {/* Close / Live P&L cell */}
        <div style={{ padding: "7px 6px", textAlign: "center" }}>
          <p style={{ color: C.sub, fontSize: "0.5rem", letterSpacing: "0.08em", textTransform: "uppercase", margin: "0 0 3px", fontFamily: FONT_UI }}>
            {isHistory ? "⤴ Close" : "〜 Live P&L"}
          </p>
          <p style={{ color: isHistory ? C.label : pnlColor, fontSize: "0.75rem", fontWeight: 700, fontFamily: FONT_MONO, margin: 0, textShadow: !isHistory ? `0 0 6px ${pnlColor}40` : "none" }}>
            {isHistory ? fmt(closePx) : `${pnlSign}${pnl.toFixed(2)}`}
          </p>
        </div>
      </div>

      {/* ── 5. TIMESTAMPS ────────────────────────────────────────────────── */}
      <div style={{ padding: "7px 12px 8px", display: "flex", flexDirection: "column", gap: 4 }}>

        {openDt && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              width: 22, height: 22, borderRadius: 6, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "0.65rem",
              background: "rgba(255,255,255,0.04)", border: `1px solid ${C.cardBdr}`,
            }}>📂</span>
            <div style={{ minWidth: 0 }}>
              <span style={{
                color: C.sub, fontSize: "0.52rem", letterSpacing: "0.08em",
                textTransform: "uppercase", marginRight: 5, fontFamily: FONT_UI,
              }}>Opened</span>
              <span style={{ color: C.label, fontSize: "0.68rem", fontFamily: FONT_MONO }}>
                {fmtStamp(openDt)}
              </span>
            </div>
          </div>
        )}

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
              <span style={{
                color: C.sub, fontSize: "0.52rem", letterSpacing: "0.08em",
                textTransform: "uppercase", marginRight: 5, fontFamily: FONT_UI,
              }}>Closed</span>
              <span style={{ color: C.label, fontSize: "0.68rem", fontFamily: FONT_MONO }}>
                {fmtStamp(closeDt)}
              </span>
            </div>
          </div>
        )}

        <div style={{
          display: "flex", alignItems: "center",
          justifyContent: "space-between", marginTop: 1,
        }}>
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
          {id && (
            <span style={{ color: C.sub, fontSize: "0.55rem", fontFamily: FONT_MONO }}>
              ID: {id}
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