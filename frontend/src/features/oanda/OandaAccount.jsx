/**
 * src/features/oanda/OandaAccount.jsx
 * Oanda account summary + open trades (deduplicated by instrument) + history
 */
import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import api from "../../store/api";

const C = {
  bg:      "#0a0a0f",
  card:    "rgba(255,255,255,0.04)",
  border:  "rgba(255,255,255,0.08)",
  white:   "#FFFFFF",
  sub:     "rgba(255,255,255,0.45)",
  green:   "#4ADE80",
  red:     "#F87171",
  amber:   "#FBBF24",
};
const FONT_MONO = "'JetBrains Mono', monospace";
const FONT_UI   = "'Inter', sans-serif";

const TAB_VARIANTS = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.18 } },
  exit:    { opacity: 0, y: -6, transition: { duration: 0.12 } },
};

function SummaryCard({ label, value, sub, color }) {
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`,
      borderRadius: 12, padding: "14px 16px",
    }}>
      <p style={{ color: C.sub, fontSize: "0.65rem", margin: "0 0 4px", fontFamily: FONT_UI }}>{label}</p>
      <p style={{ color: color ?? C.white, fontSize: "1.05rem", fontWeight: 700, margin: 0, fontFamily: FONT_MONO }}>{value ?? "—"}</p>
      {sub && <p style={{ color: C.sub, fontSize: "0.6rem", margin: "3px 0 0", fontFamily: FONT_UI }}>{sub}</p>}
    </div>
  );
}

function TradeRow({ trade, onClose }) {
  const pl     = parseFloat(trade.unrealizedPL ?? trade.realizedPL ?? 0);
  const isOpen = trade.state === "OPEN" || trade.currentUnits !== undefined;
  const plColor = pl >= 0 ? C.green : C.red;
  const units  = trade.currentUnits ?? trade.initialUnits ?? 0;
  const dir    = parseFloat(units) >= 0 ? "LONG" : "SHORT";

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "11px 14px",
      borderBottom: `1px solid ${C.border}`,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ color: C.white, fontSize: "0.82rem", fontWeight: 600, margin: 0, fontFamily: FONT_MONO }}>
          {trade.instrument}
        </p>
        <p style={{ color: C.sub, fontSize: "0.6rem", margin: "2px 0 0", fontFamily: FONT_UI }}>
          {dir} · {Math.abs(units)} units · ID {trade.id}
        </p>
      </div>
      <div style={{ textAlign: "right" }}>
        <p style={{ color: plColor, fontSize: "0.82rem", fontWeight: 700, margin: 0, fontFamily: FONT_MONO }}>
          {pl >= 0 ? "+" : ""}{pl.toFixed(2)}
        </p>
        <p style={{ color: C.sub, fontSize: "0.6rem", margin: "2px 0 0" }}>
          {trade.price ? `@ ${parseFloat(trade.price).toFixed(5)}` : ""}
        </p>
      </div>
      {isOpen && onClose && (
        <button
          onClick={() => onClose(trade.id)}
          style={{
            background: "rgba(248,113,113,0.12)", border: "1px solid rgba(248,113,113,0.3)",
            color: C.red, borderRadius: 8, padding: "4px 10px",
            fontSize: "0.65rem", cursor: "pointer", fontFamily: FONT_UI,
          }}
        >
          Close
        </button>
      )}
    </div>
  );
}

export default function OandaAccount({ accent = "#3B82F6" }) {
  const [tab,          setTab]          = useState("summary");
  const [summary,      setSummary]      = useState(null);
  const [openTrades,   setOpenTrades]   = useState([]);
  const [history,      setHistory]      = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, o, h] = await Promise.all([
        api.get("/account"),
        api.get("/account/trades"),
        api.get("/account/history"),
      ]);
      setSummary(s.data);

      /**
       * DEDUPLICATION FIX:
       * Oanda sometimes returns multiple entries for the same instrument when a
       * position was partially closed and re-opened.  Group by instrument and sum
       * unrealizedPL / currentUnits so the user sees one row per pair.
       */
      const tradeMap = new Map();
      for (const t of (o.data ?? [])) {
        const ins = t.instrument;
        if (!tradeMap.has(ins)) {
          tradeMap.set(ins, { ...t });
        } else {
          const existing = tradeMap.get(ins);
          existing.unrealizedPL = (
            parseFloat(existing.unrealizedPL ?? 0) + parseFloat(t.unrealizedPL ?? 0)
          ).toFixed(2);
          existing.currentUnits = (
            parseFloat(existing.currentUnits ?? 0) + parseFloat(t.currentUnits ?? 0)
          ).toFixed(0);
          // Keep the earliest open trade's ID for close action
        }
      }
      setOpenTrades(Array.from(tradeMap.values()));
      setHistory(h.data ?? []);
    } catch (e) {
      setError(e?.response?.data?.detail ?? e.message ?? "Failed to load account");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleClose = async (tradeId) => {
    try {
      await api.post("/trade/close", { trade_id: String(tradeId), broker: "oanda" });
      fetchAll();
    } catch (e) {
      alert("Close failed: " + (e?.response?.data?.detail ?? e.message));
    }
  };

  const tabs = ["summary", "openTrades", "history"];
  const tabLabels = { summary: "Summary", openTrades: "Open Trades", history: "History" };

  return (
    <div style={{ fontFamily: FONT_UI }}>
      {/* Tab bar */}
      <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        {tabs.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, padding: "8px 0",
            background: tab === t ? `${accent}22` : "transparent",
            border: `1px solid ${tab === t ? accent : C.border}`,
            color: tab === t ? accent : C.sub,
            borderRadius: 8, fontSize: "0.72rem", cursor: "pointer",
            fontFamily: FONT_UI, fontWeight: tab === t ? 600 : 400,
            transition: "all 0.15s",
          }}>
            {tabLabels[t]}
            {t === "openTrades" && openTrades.length > 0 && (
              <span style={{
                marginLeft: 5, background: accent, color: "#000",
                borderRadius: 10, padding: "1px 6px", fontSize: "0.6rem",
              }}>{openTrades.length}</span>
            )}
          </button>
        ))}
      </div>

      {loading && <p style={{ color: C.sub, textAlign: "center", padding: 24 }}>Loading…</p>}
      {error   && <p style={{ color: C.red,  textAlign: "center", padding: 12, fontSize: "0.78rem" }}>{error}</p>}

      <AnimatePresence mode="wait">
        {/* Summary tab */}
        {tab === "summary" && summary && (
          <motion.div key="summary" variants={TAB_VARIANTS} initial="initial" animate="animate" exit="exit">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <SummaryCard label="NAV" value={`$${parseFloat(summary.NAV ?? 0).toFixed(2)}`} />
              <SummaryCard label="Balance" value={`$${parseFloat(summary.balance ?? 0).toFixed(2)}`} />
              <SummaryCard label="Unrealized P&L"
                value={`${parseFloat(summary.unrealizedPL ?? 0) >= 0 ? "+" : ""}$${parseFloat(summary.unrealizedPL ?? 0).toFixed(2)}`}
                color={parseFloat(summary.unrealizedPL ?? 0) >= 0 ? C.green : C.red} />
              <SummaryCard label="Margin Used" value={`$${parseFloat(summary.marginUsed ?? 0).toFixed(2)}`} color={C.amber} />
              <SummaryCard label="Open Trades" value={summary.openTradeCount ?? 0} />
              <SummaryCard label="Currency" value={summary.currency ?? "USD"} />
            </div>
          </motion.div>
        )}

        {/* Open trades tab */}
        {tab === "openTrades" && (
          <motion.div key="openTrades" variants={TAB_VARIANTS} initial="initial" animate="animate" exit="exit">
            {openTrades.length === 0
              ? <p style={{ color: C.sub, textAlign: "center", padding: 24 }}>No open trades</p>
              : (
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
                  {openTrades.map(t => (
                    <TradeRow key={t.id} trade={t} onClose={handleClose} />
                  ))}
                </div>
              )}
          </motion.div>
        )}

        {/* History tab */}
        {tab === "history" && (
          <motion.div key="history" variants={TAB_VARIANTS} initial="initial" animate="animate" exit="exit">
            {history.length === 0
              ? <p style={{ color: C.sub, textAlign: "center", padding: 24 }}>No closed trades</p>
              : (
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
                  {history.map(t => <TradeRow key={t.id} trade={t} />)}
                </div>
              )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
