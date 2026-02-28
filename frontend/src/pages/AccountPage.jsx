/**
 * AccountPage
 * ══════════════════════════════════════════════════════════════════
 * Layout (top → bottom):
 *   1. Sticky header
 *   2. Master Auto-Trade toggle  ← ALWAYS visible regardless of Oanda state
 *   3. Tab bar: Summary | Open Trades | History
 *   4. Tab content panel
 *
 * ALL text uses explicit inline color values so text is readable on every
 * deployment target (Vercel, iPhone Safari) without depending on Tailwind
 * purge output or void-* class availability.
 *
 * Backend routes consumed:
 *   GET  /api/account            → summary
 *   GET  /api/account/trades     → open positions
 *   GET  /api/account/history    → last 50 closed trades
 *   GET  /api/auth/me            → auto_trade_enabled
 *   PATCH /api/users/me/settings → toggle auto_trade_enabled
 */
import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import api from "../utils/api";
import { useAuthStore } from "../store/authStore";

// ── Shared colour tokens ──────────────────────────────────────────────────────
const C = {
  green:     "#00FF41",
  greenDim:  "rgba(0,255,65,0.12)",
  greenBdr:  "rgba(0,255,65,0.25)",
  red:       "#FF3A3A",
  amber:     "#FFB800",
  white:     "#ffffff",
  label:     "#aaaaaa",    // muted labels — readable on dark bg (≥5:1)
  sub:       "#666666",    // secondary only
  card:      "#0f0f0f",
  cardBdr:   "rgba(255,255,255,0.07)",
  sheet:     "#141414",
};

const TABS = ["Summary", "Open Trades", "History"];

// ─────────────────────────────────────────────────────────────────────────────
export default function AccountPage() {
  const { user, fetchMe, updateAutoTrade } = useAuthStore();

  const [toggling,    setToggling]    = useState(false);
  const [toggleError, setToggleError] = useState(null);
  const autoTradeOn = user?.auto_trade_enabled ?? false;

  const [activeTab, setActiveTab] = useState("Summary");
  const [account,   setAccount]   = useState(null);
  const [trades,    setTrades]    = useState([]);
  const [history,   setHistory]   = useState([]);
  const [loading,   setLoading]   = useState({});
  const [errors,    setErrors]    = useState({});

  useEffect(() => { fetchMe(); }, []); // eslint-disable-line

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
    <div style={{ fontFamily: "'DM Sans', sans-serif", color: C.white, minHeight: "100%" }}>

      {/* ── Sticky header ──────────────────────────────────────────────── */}
      <div style={{
        position: "sticky", top: 0, zIndex: 20,
        padding: "16px 16px 12px",
        background: "rgba(5,5,5,0.97)",
        backdropFilter: "blur(20px)",
        borderBottom: "1px solid rgba(0,255,65,0.08)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1 style={{ color: C.white, fontSize: "1.2rem", fontWeight: 700, letterSpacing: "0.03em", margin: 0 }}>
              Account
            </h1>
            <p style={{ color: C.label, fontSize: "0.7rem", margin: "2px 0 0" }}>Oanda v20 · Live data</p>
          </div>
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
            <span style={{ color: C.green, fontSize: "0.65rem", fontWeight: 700, letterSpacing: "0.1em" }}>LIVE</span>
          </div>
        </div>
      </div>

      {/* ── Content ───────────────────────────────────────────────────── */}
      <div style={{ padding: "16px 16px 32px", display: "flex", flexDirection: "column", gap: 12 }}>

        {/* ── AUTO-TRADE TOGGLE (always first, always visible) ───────── */}
        <AutoTradeToggle isOn={autoTradeOn} toggling={toggling} error={toggleError} onToggle={handleToggle} />

        {/* ── TAB BAR ──────────────────────────────────────────────────── */}
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
                  flex: 1,
                  minHeight: 46,
                  border: "none",
                  background: active ? C.greenDim : "transparent",
                  color: active ? C.green : C.label,
                  fontSize: "0.72rem",
                  fontWeight: active ? 700 : 500,
                  letterSpacing: "0.07em",
                  cursor: "pointer",
                  position: "relative",
                  transition: "background 0.18s, color 0.18s",
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

        {/* ── TAB CONTENT ──────────────────────────────────────────────── */}
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
          >
            {activeTab === "Summary"     && <SummaryTab    account={account} loading={loading.Summary}          error={errors.Summary}          onRetry={loadSummary} />}
            {activeTab === "Open Trades" && <OpenTradesTab trades={trades}   loading={loading["Open Trades"]}   error={errors["Open Trades"]}   onRetry={loadTrades}  />}
            {activeTab === "History"     && <HistoryTab    history={history}  loading={loading.History}          error={errors.History}          onRetry={loadHistory} />}
          </motion.div>
        </AnimatePresence>

      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  AutoTradeToggle
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

          {/* Icon */}
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

          {/* Label */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ color: C.white, fontSize: "0.9rem", fontWeight: 600, margin: 0, letterSpacing: "0.02em" }}>
              Master Auto-Trade
            </p>
            <motion.p
              animate={{ color: isOn ? C.green : C.sub }}
              transition={{ duration: 0.2 }}
              style={{ fontSize: "0.68rem", margin: "3px 0 0", letterSpacing: "0.04em" }}
            >
              {isOn ? "ACTIVE — signals execute automatically" : "OFF — signals monitored only"}
            </motion.p>
          </div>

          {/* Toggle pill — min 44px touch target */}
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

        {/* Warning when active */}
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
                color: C.amber, fontSize: "0.68rem", lineHeight: 1.5,
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
              style={{ marginTop: 8, fontSize: "0.68rem", color: C.red }}
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
//  Shared helpers
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
      <p style={{ color: C.red, fontSize: "0.82rem", fontWeight: 600, margin: "0 0 6px" }}>Connection Error</p>
      <p style={{ color: C.label, fontSize: "0.72rem", lineHeight: 1.5, margin: 0 }}>{message}</p>
      <button
        onClick={onRetry}
        style={{
          marginTop: 12, padding: "6px 18px", borderRadius: 10,
          background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)",
          color: C.white, fontSize: "0.7rem", letterSpacing: "0.08em", cursor: "pointer",
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
        <p style={{ color: C.label, fontSize: "0.8rem", letterSpacing: "0.05em", margin: "0 0 4px" }}>{title}</p>
        <p style={{ color: C.sub, fontSize: "0.68rem", margin: 0 }}>{sub}</p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Summary tab
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
      {/* Account ID banner */}
      <div style={{
        padding: 16, borderRadius: 16,
        background: "rgba(0,255,65,0.04)", border: `1px solid ${C.greenBdr}`,
      }}>
        <p style={{ color: C.label, fontSize: "0.62rem", letterSpacing: "0.1em", margin: "0 0 6px" }}>ACCOUNT ID</p>
        <p style={{
          color: C.green, fontSize: "0.85rem", fontWeight: 700,
          fontFamily: "'JetBrains Mono', monospace", margin: "0 0 4px",
        }}>{account.id}</p>
        <p style={{ color: C.label, fontSize: "0.7rem", textTransform: "capitalize", margin: 0 }}>
          {account.type?.toLowerCase() ?? "—"} account
        </p>
      </div>

      {/* 2-col stat grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {stats.map((stat, i) => {
          const pnlVal  = stat.pnl ? parseFloat(stat.value.replace("$","")) : null;
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
              <p style={{ color: C.label, fontSize: "0.6rem", letterSpacing: "0.1em", margin: "0 0 8px" }}>
                {stat.label.toUpperCase()}
              </p>
              <p style={{
                color: valColor, fontSize: "1.05rem", fontWeight: 700,
                fontFamily: "'JetBrains Mono', monospace", margin: 0,
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
//  Open Trades tab
// ─────────────────────────────────────────────────────────────────────────────
function OpenTradesTab({ trades, loading, error, onRetry }) {
  if (loading) return <TabLoading />;
  if (error)   return <TabError message={error} onRetry={onRetry} />;
  if (!trades.length) return <TabEmpty icon="📭" title="No open positions" sub="Live trades will appear here once placed" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {trades.map((t, i) => {
        const units = parseInt(t.currentUnits ?? t.initialUnits ?? 0);
        const isLong = units > 0;
        const pnl = parseFloat(t.unrealizedPL ?? 0);
        const pnlColor = pnl >= 0 ? C.green : C.red;
        const ins = (t.instrument ?? "").replace("_", "/");

        return (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            style={{
              borderRadius: 16, overflow: "hidden",
              background: C.card,
              border: `1px solid ${isLong ? "rgba(0,255,65,0.22)" : "rgba(255,58,58,0.22)"}`,
            }}
          >
            <div style={{
              height: 2,
              background: isLong
                ? "linear-gradient(90deg, transparent, #00FF41, transparent)"
                : "linear-gradient(90deg, transparent, #FF3A3A, transparent)",
            }} />
            <div style={{ padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: C.white, fontWeight: 700, fontSize: "0.95rem" }}>{ins}</span>
                  <span style={{
                    padding: "2px 8px", borderRadius: 6,
                    fontSize: "0.62rem", fontWeight: 700, letterSpacing: "0.07em",
                    color: isLong ? C.green : C.red,
                    background: isLong ? "rgba(0,255,65,0.12)" : "rgba(255,58,58,0.12)",
                    border: `1px solid ${isLong ? C.greenBdr : "rgba(255,58,58,0.3)"}`,
                  }}>
                    {isLong ? "▲ LONG" : "▼ SHORT"}
                  </span>
                </div>
                <span style={{
                  color: pnlColor, fontWeight: 700, fontSize: "0.9rem",
                  fontFamily: "'JetBrains Mono', monospace",
                }}>
                  {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                {[
                  { label: "Units",  value: Math.abs(units) },
                  { label: "Entry",  value: parseFloat(t.price ?? 0).toFixed(5) },
                  { label: "Margin", value: `$${parseFloat(t.marginUsed ?? 0).toFixed(2)}` },
                ].map(({ label, value }) => (
                  <div key={label} style={{
                    padding: "8px 6px", borderRadius: 10, textAlign: "center",
                    background: C.sheet, border: `1px solid ${C.cardBdr}`,
                  }}>
                    <p style={{ color: C.label, fontSize: "0.58rem", letterSpacing: "0.08em", margin: "0 0 4px" }}>
                      {label.toUpperCase()}
                    </p>
                    <p style={{
                      color: C.white, fontSize: "0.72rem", fontWeight: 600,
                      fontFamily: "'JetBrains Mono', monospace", margin: 0,
                    }}>{value}</p>
                  </div>
                ))}
              </div>
              <p style={{ color: C.sub, fontSize: "0.62rem", marginTop: 10 }}>
                Opened {new Date(t.openTime).toLocaleString()}
              </p>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  History tab
// ─────────────────────────────────────────────────────────────────────────────
function HistoryTab({ history, loading, error, onRetry }) {
  if (loading) return <TabLoading />;
  if (error)   return <TabError message={error} onRetry={onRetry} />;
  if (!history.length) return <TabEmpty icon="📜" title="No closed trades" sub="Your trade history will appear here" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {history.map((t, i) => {
        const units = parseInt(t.initialUnits ?? 0);
        const isLong = units > 0;
        const pnl = parseFloat(t.realizedPL ?? 0);
        const pnlColor = pnl >= 0 ? C.green : C.red;
        const ins = (t.instrument ?? "").replace("_", "/");

        return (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.03, 0.3) }}
            style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "12px 14px", borderRadius: 14,
              background: C.card, border: `1px solid ${C.cardBdr}`,
            }}
          >
            <div style={{
              width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
              background: isLong ? C.green : C.red,
              boxShadow: `0 0 6px ${isLong ? C.green : C.red}`,
            }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ color: C.white, fontSize: "0.88rem", fontWeight: 600, margin: "0 0 3px" }}>{ins}</p>
              <p style={{ color: C.sub, fontSize: "0.62rem", margin: 0 }}>
                {isLong ? "Long" : "Short"} · {Math.abs(units)} units
              </p>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <p style={{
                color: pnlColor, fontSize: "0.9rem", fontWeight: 700,
                fontFamily: "'JetBrains Mono', monospace",
                textShadow: `0 0 6px ${pnlColor}60`, margin: "0 0 3px",
              }}>
                {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}
              </p>
              <p style={{ color: C.sub, fontSize: "0.6rem", margin: 0 }}>
                {t.closeTime ? new Date(t.closeTime).toLocaleDateString() : "—"}
              </p>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}