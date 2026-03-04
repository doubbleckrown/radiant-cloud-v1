/**
 * src/features/bybit/BybitAccount.jsx
 * Bybit account summary + open positions + trade history with three tabs.
 */
import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import api from "../../store/api";

const C = {
  bg: "#0a0a0f", card: "rgba(255,255,255,0.04)", border: "rgba(255,255,255,0.08)",
  white: "#FFFFFF", sub: "rgba(255,255,255,0.45)", green: "#4ADE80", red: "#F87171", amber: "#FBBF24",
};
const FONT_MONO = "'JetBrains Mono', monospace";
const FONT_UI   = "'Inter', sans-serif";

const TAB_V = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.18 } },
  exit:    { opacity: 0, y: -6, transition: { duration: 0.12 } },
};

function SummaryCard({ label, value, color }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px" }}>
      <p style={{ color: C.sub, fontSize: "0.65rem", margin: "0 0 4px", fontFamily: FONT_UI }}>{label}</p>
      <p style={{ color: color ?? C.white, fontSize: "1.05rem", fontWeight: 700, margin: 0, fontFamily: FONT_MONO }}>{value ?? "—"}</p>
    </div>
  );
}

function PositionRow({ pos, onClose }) {
  const size  = parseFloat(pos.size ?? 0);
  const upl   = parseFloat(pos.unrealisedPnl ?? 0);
  const side  = pos.side ?? "Buy";
  const color = upl >= 0 ? C.green : C.red;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", borderBottom: `1px solid ${C.border}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ color: C.white, fontSize: "0.82rem", fontWeight: 600, margin: 0, fontFamily: FONT_MONO }}>{pos.symbol}</p>
        <p style={{ color: C.sub, fontSize: "0.6rem", margin: "2px 0 0", fontFamily: FONT_UI }}>
          {side} · {size} · Entry {parseFloat(pos.avgPrice ?? 0).toFixed(4)}
        </p>
      </div>
      <div style={{ textAlign: "right" }}>
        <p style={{ color, fontSize: "0.82rem", fontWeight: 700, margin: 0, fontFamily: FONT_MONO }}>
          {upl >= 0 ? "+" : ""}{upl.toFixed(2)} USDT
        </p>
        <p style={{ color: C.sub, fontSize: "0.6rem", margin: "2px 0 0" }}>
          Liq {parseFloat(pos.liqPrice ?? 0).toFixed(4)}
        </p>
      </div>
      {onClose && (
        <button onClick={() => onClose(pos.symbol, side, String(size))} style={{
          background: "rgba(248,113,113,0.12)", border: "1px solid rgba(248,113,113,0.3)",
          color: C.red, borderRadius: 8, padding: "4px 10px", fontSize: "0.65rem", cursor: "pointer",
        }}>Close</button>
      )}
    </div>
  );
}

function HistoryRow({ order }) {
  const pnl   = parseFloat(order.closedPnl ?? 0);
  const color = pnl >= 0 ? C.green : C.red;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderBottom: `1px solid ${C.border}` }}>
      <div style={{ flex: 1 }}>
        <p style={{ color: C.white, fontSize: "0.8rem", fontWeight: 600, margin: 0, fontFamily: FONT_MONO }}>{order.symbol}</p>
        <p style={{ color: C.sub, fontSize: "0.6rem", margin: "2px 0 0" }}>{order.side} · {order.qty} · {order.orderStatus}</p>
      </div>
      <p style={{ color, fontFamily: FONT_MONO, fontSize: "0.8rem", fontWeight: 700, margin: 0 }}>
        {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}
      </p>
    </div>
  );
}

export default function BybitAccount({ accent = "#F59E0B" }) {
  const [tab,       setTab]       = useState("summary");
  const [summary,   setSummary]   = useState(null);
  const [positions, setPositions] = useState([]);
  const [history,   setHistory]   = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState(null);

  const fetchAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [s, p, h] = await Promise.all([
        api.get("/bybit/account"),
        api.get("/bybit/account/positions"),
        api.get("/bybit/account/history"),
      ]);
      setSummary(s.data);
      setPositions(p.data ?? []);
      setHistory(h.data ?? []);
    } catch (e) {
      setError(e?.response?.data?.detail ?? e?.response?.data?.error ?? e.message ?? "Failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleClose = async (symbol, side, qty) => {
    try {
      await api.post("/trade/close", { symbol, side, qty, broker: "bybit" });
      fetchAll();
    } catch (e) {
      alert("Close failed: " + (e?.response?.data?.detail ?? e.message));
    }
  };

  const tabs = ["summary", "positions", "history"];
  const labels = { summary: "Summary", positions: "Open Positions", history: "History" };

  return (
    <div style={{ fontFamily: FONT_UI }}>
      <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        {tabs.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, padding: "8px 0",
            background: tab === t ? `${accent}22` : "transparent",
            border: `1px solid ${tab === t ? accent : C.border}`,
            color: tab === t ? accent : C.sub,
            borderRadius: 8, fontSize: "0.72rem", cursor: "pointer", fontFamily: FONT_UI,
            fontWeight: tab === t ? 600 : 400, transition: "all 0.15s",
          }}>
            {labels[t]}
            {t === "positions" && positions.length > 0 && (
              <span style={{ marginLeft: 5, background: accent, color: "#000", borderRadius: 10, padding: "1px 6px", fontSize: "0.6rem" }}>
                {positions.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {loading && <p style={{ color: C.sub, textAlign: "center", padding: 24 }}>Loading…</p>}
      {error   && <p style={{ color: C.red,  textAlign: "center", padding: 12, fontSize: "0.78rem" }}>{typeof error === "string" ? error : JSON.stringify(error)}</p>}

      <AnimatePresence mode="wait">
        {tab === "summary" && summary && (
          <motion.div key="summary" variants={TAB_V} initial="initial" animate="animate" exit="exit">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <SummaryCard label="Total Equity"     value={`$${parseFloat(summary.totalEquity ?? 0).toFixed(2)}`} />
              <SummaryCard label="Available"        value={`$${parseFloat(summary.totalAvailableBalance ?? 0).toFixed(2)}`} color={C.green} />
              <SummaryCard label="Margin Balance"   value={`$${parseFloat(summary.totalMarginBalance ?? 0).toFixed(2)}`}   color={C.amber} />
              <SummaryCard label="Account Type"     value={summary.accountType ?? "UNIFIED"} />
            </div>
          </motion.div>
        )}

        {tab === "positions" && (
          <motion.div key="positions" variants={TAB_V} initial="initial" animate="animate" exit="exit">
            {positions.length === 0
              ? <p style={{ color: C.sub, textAlign: "center", padding: 24 }}>No open positions</p>
              : <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
                  {positions.map(p => <PositionRow key={p.symbol} pos={p} onClose={handleClose} />)}
                </div>}
          </motion.div>
        )}

        {tab === "history" && (
          <motion.div key="history" variants={TAB_V} initial="initial" animate="animate" exit="exit">
            {history.length === 0
              ? <p style={{ color: C.sub, textAlign: "center", padding: 24 }}>No history</p>
              : <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
                  {history.map(o => <HistoryRow key={o.orderId ?? o.id} order={o} />)}
                </div>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
