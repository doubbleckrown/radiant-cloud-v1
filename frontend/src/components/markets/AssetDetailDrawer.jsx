/**
 * AssetDetailDrawer
 *
 * Chart data flow:
 *   1. On mount and on gran/instrument change, sends GET_CHART via WebSocket.
 *   2. Backend responds with {type:"CHART_DATA", instrument, granularity, candles}.
 *   3. useEffect([wsMessage]) receives it and calls series.setData().
 *   4. Falls back to REST if WS is not yet connected (sendWs is null/undefined).
 *
 * Props:
 *   instrument  string   — Oanda symbol, e.g. "EUR_USD"
 *   meta        object   — {label, flag, decimals, ...}
 *   price       number   — current live price from MarketsPage
 *   analysis    object   — SMC analysis state from MarketsPage
 *   onClose     fn
 *   sendWs      fn       — send(msg) from useWebSocket — requests CHART_DATA
 *   wsMessage   object   — lastMessage from useWebSocket — receives CHART_DATA
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import api from "../../utils/api";

// ── LightweightCharts loader (singleton across all drawer mounts) ─────────────
let lwcScriptPromise = null;
function ensureLWC() {
  if (window.LightweightCharts) return Promise.resolve();
  if (lwcScriptPromise)          return lwcScriptPromise;
  lwcScriptPromise = new Promise((resolve, reject) => {
    const s   = document.createElement("script");
    s.src     = "https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js";
    s.onload  = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return lwcScriptPromise;
}

// ── Format raw candle array for LightweightCharts ────────────────────────────
// Accepts both REST shape {t,o,h,l,c} and WS shape {time,open,high,low,close}
function formatCandles(raw) {
  return raw
    .map((c) => ({
      time:  c.time  ?? c.t,
      open:  c.open  ?? c.o,
      high:  c.high  ?? c.h,
      low:   c.low   ?? c.l,
      close: c.close ?? c.c,
    }))
    .filter((c) => c.time && c.open && c.high && c.low && c.close)
    .sort((a, b) => a.time - b.time);   // LightweightCharts requires ascending order
}

export default function AssetDetailDrawer({
  instrument, meta, price, analysis, onClose,
  sendWs,      // fn(msg)  — send a WS message to the backend
  wsMessage,   // object   — most recent WS message from backend
}) {
  const containerRef = useRef(null);
  const chartRef     = useRef(null);
  const seriesRef    = useRef(null);
  const resizeRef    = useRef(null);
  // Track which (instrument + gran) we last requested so we can match the response
  const pendingRef   = useRef({ instrument: null, granularity: null });

  const [gran, setGran]           = useState("H1");
  const [loading, setLoading]     = useState(false);
  const [drawerTab, setDrawerTab] = useState("chart");

  // ── Push candle data into the chart series ────────────────────────────────
  const applyCandles = useCallback((rawCandles) => {
    if (!seriesRef.current) return;
    const formatted = formatCandles(rawCandles);
    if (formatted.length === 0) {
      console.warn("[Chart] No valid candles to display");
      return;
    }
    seriesRef.current.setData(formatted);
    chartRef.current?.timeScale().fitContent();
    setLoading(false);
  }, []);

  // ── Request chart data — WS first, REST fallback ──────────────────────────
  const requestCandles = useCallback((granularity) => {
    if (!seriesRef.current) return;   // chart not ready yet
    setLoading(true);
    pendingRef.current = { instrument, granularity };

    if (sendWs) {
      // PRIMARY: request via WebSocket — backend serves from in-memory cache (instant)
      sendWs({ type: "GET_CHART", instrument, granularity });
      // The response comes back as wsMessage in the effect below
    } else {
      // FALLBACK: REST call — used if WS isn't connected yet
      api.get(`/markets/${instrument}/candles?granularity=${granularity}`)
        .then(({ data }) => applyCandles(data))
        .catch((err) => {
          console.error("[Chart] REST fallback error:", err);
          setLoading(false);
        });
    }
  }, [instrument, sendWs, applyCandles]);

  // ── Receive CHART_DATA from WebSocket ────────────────────────────────────
  useEffect(() => {
    if (!wsMessage) return;
    if (wsMessage.type !== "CHART_DATA") return;
    // Only apply if this response matches what we requested
    if (
      wsMessage.instrument  !== pendingRef.current.instrument ||
      wsMessage.granularity !== pendingRef.current.granularity
    ) return;

    applyCandles(wsMessage.candles ?? []);
  }, [wsMessage, applyCandles]);

  // ── Boot chart once on mount ──────────────────────────────────────────────
  useEffect(() => {
    let destroyed = false;

    (async () => {
      await ensureLWC();
      if (destroyed || !containerRef.current) return;

      const chart = window.LightweightCharts.createChart(containerRef.current, {
        layout: {
          background: { type: "solid", color: "#0a0a0a" },
          textColor:  "#404040",
        },
        grid: {
          vertLines: { color: "rgba(0,255,65,0.04)" },
          horzLines: { color: "rgba(0,255,65,0.04)" },
        },
        crosshair:       { mode: 1 },
        rightPriceScale: { borderColor: "rgba(0,255,65,0.12)", textColor: "#505050" },
        timeScale:       { borderColor: "rgba(0,255,65,0.12)", timeVisible: true, secondsVisible: false },
        handleScroll:    true,
        handleScale:     true,
        width:  containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });

      const series = chart.addCandlestickSeries({
        upColor:         "#00FF41",
        downColor:       "#FF3A3A",
        borderUpColor:   "#00FF41",
        borderDownColor: "#FF3A3A",
        wickUpColor:     "#00FF41",
        wickDownColor:   "#FF3A3A",
      });

      chartRef.current  = chart;
      seriesRef.current = series;

      // Immediately request the initial H1 data
      requestCandles("H1");

      resizeRef.current = new ResizeObserver((entries) => {
        const { width, height } = entries[0].contentRect;
        if (width > 0 && height > 0) chart.applyOptions({ width, height });
      });
      resizeRef.current.observe(containerRef.current);
    })();

    return () => {
      destroyed = true;
      resizeRef.current?.disconnect();
      chartRef.current?.remove();
      chartRef.current  = null;
      seriesRef.current = null;
    };
  }, []); // eslint-disable-line — intentionally runs once

  // ── Re-fetch when gran or instrument changes ──────────────────────────────
  useEffect(() => {
    if (seriesRef.current) requestCandles(gran);
  }, [gran, instrument, requestCandles]);

  // ── SMC layer display ─────────────────────────────────────────────────────
  const layers = analysis ? [
    {
      id:      "L1",
      icon:    "📈",
      title:   "Layer 1 — EMA Trend",
      subtitle:"200 EMA w/ 0.01% hysteresis",
      active:  analysis.layer1?.active,
      detail:  analysis.layer1?.bias ?? "NEUTRAL",
    },
    {
      id:      "L2",
      icon:    "🏦",
      title:   "Layer 2 — Value Zone",
      subtitle:"Order Block / Fair Value Gap",
      active:  analysis.layer2?.active,
      detail:  analysis.layer2?.zone ?? "Scanning…",
    },
    {
      id:      "L3",
      icon:    "🎯",
      title:   "Layer 3 — MSS Trigger",
      subtitle:"Market Structure Shift — body close",
      active:  analysis.layer3?.mss,
      detail:  analysis.layer3?.mss ? "Structure broken ✓" : "Awaiting break",
    },
  ] : [];

  return (
    <>
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-40"
        style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)" }}
      />

      {/* Sheet */}
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", stiffness: 300, damping: 35 }}
        className="fixed left-0 right-0 bottom-0 z-50 flex flex-col"
        style={{
          height:       "88vh",
          background:   "#0a0a0a",
          borderTop:    "1px solid rgba(0,255,65,0.15)",
          borderRadius: "1.5rem 1.5rem 0 0",
          boxShadow:    "0 -16px 64px rgba(0,0,0,0.9)",
          paddingBottom:"env(safe-area-inset-bottom)",
        }}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
          <div className="w-10 h-1 rounded-full" style={{ background: "rgba(255,255,255,0.1)" }} />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center"
              style={{ background: "rgba(0,255,65,0.08)", border: "1px solid rgba(0,255,65,0.15)" }}
            >
              <span className="text-lg">{meta?.flag?.split("/")[0]}</span>
            </div>
            <div>
              <h2 className="font-display text-white text-lg tracking-wide">{meta?.label}</h2>
              <span
                className="font-mono text-2xl font-bold"
                style={{
                  color:      "#00FF41",
                  textShadow: "0 0 12px rgba(0,255,65,0.6)",
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {price?.toFixed(meta?.decimals ?? 5) ?? "—"}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ConfidenceRing confidence={analysis?.confidence ?? 0} />
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-full"
              style={{ background: "#1a1a1a" }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" stroke="#666" strokeWidth="2" fill="none">
                <line x1="18" y1="6" x2="6"  y2="18"/>
                <line x1="6"  y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Tab switcher */}
        <div className="flex px-5 gap-1 mb-3 flex-shrink-0">
          {["chart", "analysis"].map((tab) => (
            <button
              key={tab}
              onClick={() => setDrawerTab(tab)}
              className="flex-1 py-2 text-sm font-display tracking-wider uppercase rounded-lg transition-all"
              style={{
                background: drawerTab === tab ? "rgba(0,255,65,0.08)" : "transparent",
                border:     `1px solid ${drawerTab === tab ? "rgba(0,255,65,0.25)" : "rgba(255,255,255,0.05)"}`,
                color:      drawerTab === tab ? "#00FF41" : "#404040",
              }}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* ── Chart tab ─────────────────────────────────────────────────────── */}
        <div
          className="flex-1 flex flex-col min-h-0"
          style={{ display: drawerTab === "chart" ? "flex" : "none" }}
        >
          {/* Granularity buttons */}
          <div className="flex gap-2 px-5 mb-3 flex-shrink-0">
            {["M5", "M15", "H1"].map((g) => (
              <button
                key={g}
                onClick={() => setGran(g)}
                disabled={loading}
                className="px-4 py-1.5 text-xs font-display tracking-wider uppercase rounded-lg transition-all"
                style={{
                  background: gran === g ? "rgba(0,255,65,0.1)"           : "rgba(255,255,255,0.04)",
                  border:     `1px solid ${gran === g ? "rgba(0,255,65,0.3)" : "rgba(255,255,255,0.05)"}`,
                  color:      gran === g ? "#00FF41"                       : "#555",
                  opacity:    loading ? 0.5 : 1,
                  cursor:     loading ? "not-allowed" : "pointer",
                }}
              >
                {g}
              </button>
            ))}
            {loading && (
              <div className="flex items-center gap-1.5 ml-auto">
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
                  className="w-3 h-3 rounded-full border border-transparent"
                  style={{ borderTopColor: "#00FF41" }}
                />
                <span className="text-void-700 text-[10px] font-display">Loading</span>
              </div>
            )}
          </div>

          {/* Chart container */}
          <div
            ref={containerRef}
            className="flex-1 mx-3 rounded-xl overflow-hidden"
            style={{ minHeight: 0 }}
          />
        </div>

        {/* ── Analysis tab ──────────────────────────────────────────────────── */}
        {drawerTab === "analysis" && (
          <div className="flex-1 overflow-y-auto px-5 pb-4 space-y-3">
            {/* Overall confluence bar */}
            <div
              className="p-4 rounded-2xl"
              style={{ background: "#141414", border: "1px solid rgba(0,255,65,0.08)" }}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-display text-xs tracking-wider text-void-800 uppercase">
                  SMC Confluence
                </span>
                <span
                  className="font-display text-sm tracking-wide"
                  style={{ color: analysis?.confidence === 100 ? "#00FF41" : "#FFB800" }}
                >
                  {analysis?.confidence ?? 0}%
                </span>
              </div>
              <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: "#1a1a1a" }}>
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${analysis?.confidence ?? 0}%` }}
                  transition={{ duration: 0.8, ease: "easeOut" }}
                  className="h-full rounded-full"
                  style={{
                    background: analysis?.confidence === 100
                      ? "linear-gradient(90deg, #00FF41, #00cc34)"
                      : "linear-gradient(90deg, #FFB800, #ff8800)",
                    boxShadow:  analysis?.confidence === 100 ? "0 0 8px rgba(0,255,65,0.6)" : "none",
                  }}
                />
              </div>
            </div>

            {/* Layer cards */}
            {layers.map((layer, i) => (
              <motion.div
                key={layer.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.08 }}
                className="p-4 rounded-2xl"
                style={{
                  background: "#141414",
                  border:    `1px solid ${layer.active ? "rgba(0,255,65,0.18)" : "rgba(255,255,255,0.05)"}`,
                  boxShadow:  layer.active ? "0 0 12px rgba(0,255,65,0.06)" : "none",
                }}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-9 h-9 rounded-xl flex items-center justify-center text-base flex-shrink-0"
                    style={{
                      background: layer.active ? "rgba(0,255,65,0.1)"      : "rgba(255,255,255,0.04)",
                      border:    `1px solid ${layer.active ? "rgba(0,255,65,0.2)" : "rgba(255,255,255,0.06)"}`,
                    }}
                  >
                    {layer.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-display text-sm text-white tracking-wide">{layer.title}</span>
                      <span
                        className="font-display text-[10px] tracking-wider uppercase px-1.5 py-0.5 rounded"
                        style={{
                          background: layer.active ? "rgba(0,255,65,0.12)"    : "rgba(255,58,58,0.1)",
                          color:      layer.active ? "#00FF41"                : "#FF3A3A",
                          border:    `1px solid ${layer.active ? "rgba(0,255,65,0.25)" : "rgba(255,58,58,0.2)"}`,
                        }}
                      >
                        {layer.active ? "✓ Active" : "Pending"}
                      </span>
                    </div>
                    <div className="text-void-700 text-xs mt-0.5">{layer.subtitle}</div>
                  </div>
                </div>
                <div
                  className="mt-3 px-3 py-2 rounded-xl font-mono text-xs"
                  style={{
                    background: "rgba(0,0,0,0.4)",
                    border:     "1px solid rgba(255,255,255,0.05)",
                    color:      "#00FF41",
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  {layer.detail}
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </motion.div>
    </>
  );
}

// ── Confidence Ring ───────────────────────────────────────────────────────────
function ConfidenceRing({ confidence }) {
  const r     = 18, cx = 22, cy = 22;
  const circ  = 2 * Math.PI * r;
  const dash  = (confidence / 100) * circ;
  const color = confidence === 100 ? "#00FF41" : confidence >= 67 ? "#FFB800" : "#FF3A3A";
  return (
    <div className="relative w-11 h-11">
      <svg width="44" height="44" viewBox="0 0 44 44">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="3"/>
        <motion.circle
          cx={cx} cy={cy} r={r}
          fill="none" stroke={color} strokeWidth="3"
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
          transform="rotate(-90 22 22)"
          initial={{ strokeDasharray: `0 ${circ}` }}
          animate={{ strokeDasharray: `${dash} ${circ}` }}
          transition={{ duration: 1, ease: "easeOut" }}
          style={{ filter: `drop-shadow(0 0 3px ${color})` }}
        />
      </svg>
      <span
        className="absolute inset-0 flex items-center justify-center font-display text-[10px] tracking-wider"
        style={{ color }}
      >
        {confidence}%
      </span>
    </div>
  );
}