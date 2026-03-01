/**
 * MarketsPage
 * ══════════════════════════════════════════════════════════════
 * • Live prices via WebSocket
 * • Accordion: click any instrument → inline LW-Charts area chart
 *   expands directly under that row, pushing rows below it down
 * • Design tokens identical to AccountPage.jsx (C.card, C.cardBdr …)
 * • Font: Inter (UI)  ·  JetBrains Mono (price numerics)
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence }  from "framer-motion";
import { createChart }              from "lightweight-charts";
import { useWebSocket }             from "../hooks/useWebSocket";
import api                          from "../utils/api";

// ── Design tokens (mirrors AccountPage exactly) ───────────────────────────────
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

// ── Instrument metadata ────────────────────────────────────────────────────────
const INSTRUMENT_META = {
  EUR_USD:    { label: "EUR/USD",  flag: "🇪🇺", category: "Forex",   decimals: 5 },
  GBP_USD:    { label: "GBP/USD",  flag: "🇬🇧", category: "Forex",   decimals: 5 },
  USD_JPY:    { label: "USD/JPY",  flag: "🇺🇸", category: "Forex",   decimals: 3 },
  AUD_USD:    { label: "AUD/USD",  flag: "🇦🇺", category: "Forex",   decimals: 5 },
  NZD_USD:    { label: "NZD/USD",  flag: "🇳🇿", category: "Forex",   decimals: 5 },
  USD_CAD:    { label: "USD/CAD",  flag: "🇨🇦", category: "Forex",   decimals: 5 },
  USD_CHF:    { label: "USD/CHF",  flag: "🇨🇭", category: "Forex",   decimals: 5 },
  XAU_USD:    { label: "XAU/USD",  flag: "🥇", category: "Metals",  decimals: 2 },
  NAS100_USD: { label: "NAS100",   flag: "📈", category: "Indices", decimals: 1 },
  US30_USD:   { label: "US30",     flag: "🏛️", category: "Indices", decimals: 1 },
  SPX500_USD: { label: "SPX500",   flag: "📊", category: "Indices", decimals: 1 },
  GER30_EUR:  { label: "GER30",    flag: "🇩🇪", category: "Indices", decimals: 1 },
  UK100_GBP:  { label: "UK100",    flag: "🇬🇧", category: "Indices", decimals: 1 },
  J225_USD:   { label: "J225",     flag: "🇯🇵", category: "Indices", decimals: 0 },
  BTC_USD:    { label: "BTC/USD",  flag: "₿",  category: "Crypto",  decimals: 1 },
};

const CATEGORIES = ["All", "Forex", "Metals", "Indices", "Crypto"];

// ═════════════════════════════════════════════════════════════════════════════
export default function MarketsPage() {
  const [prices,       setPrices]    = useState({});
  const [flickerState, setFlicker]   = useState({});
  const [analysis,     setAnalysis]  = useState({});
  const [openIns,      setOpenIns]   = useState(null);   // accordion state
  const [filter,       setFilter]    = useState("All");
  const [search,       setSearch]    = useState("");
  const tickerRef = useRef({});

  const { lastMessage, send } = useWebSocket();

  // Subscribe for immediate price when accordion opens
  useEffect(() => {
    if (openIns) send({ type: "SUBSCRIBE", instrument: openIns });
  }, [openIns, send]);

  // Handle WS messages
  useEffect(() => {
    if (!lastMessage) return;
    const msg = lastMessage;
    if (msg.type === "TICK") {
      const { instrument, mid } = msg;
      setPrices(prev => {
        const prevPrice = prev[instrument];
        if (prevPrice !== undefined && mid !== prevPrice) {
          const dir = mid > prevPrice ? "up" : "down";
          setFlicker(f => ({ ...f, [instrument]: dir }));
          clearTimeout(tickerRef.current[instrument]);
          tickerRef.current[instrument] = setTimeout(() =>
            setFlicker(f => ({ ...f, [instrument]: null })), 450);
        }
        return { ...prev, [instrument]: mid };
      });
    }
    if (msg.type === "SNAPSHOT") setPrices(msg.prices || {});
  }, [lastMessage]);

  // Periodic SMC analysis
  useEffect(() => {
    const fetch = async () => {
      const keys    = Object.keys(INSTRUMENT_META);
      const results = await Promise.allSettled(keys.map(k => api.get(`/markets/${k}/analysis`)));
      const merged  = {};
      keys.forEach((k, i) => {
        if (results[i].status === "fulfilled") merged[k] = results[i].value.data;
      });
      setAnalysis(merged);
    };
    fetch();
    const id = setInterval(fetch, 30_000);
    return () => clearInterval(id);
  }, []);

  const filtered = Object.entries(INSTRUMENT_META).filter(([key, meta]) => {
    const catOk  = filter === "All" || meta.category === filter;
    const srchOk = meta.label.toLowerCase().includes(search.toLowerCase());
    return catOk && srchOk;
  });

  const handleRowClick = useCallback((ins) => {
    setOpenIns(prev => prev === ins ? null : ins);
  }, []);

  return (
    <div style={{ fontFamily: FONT_UI, color: C.white, minHeight: "100%" }}>

      {/* ── Sticky header ─────────────────────────────────────────────────── */}
      <div style={{
        position:       "sticky",
        top:            0,
        zIndex:         20,
        padding:        "16px 16px 12px",
        background:     "rgba(5,5,5,0.97)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderBottom:   "1px solid rgba(0,255,65,0.08)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <h1 style={{ color: C.white, fontSize: "1.2rem", fontWeight: 700, letterSpacing: "0.03em", margin: 0 }}>
              Markets
            </h1>
            <p style={{ color: C.label, fontSize: "0.7rem", margin: "2px 0 0" }}>
              {Object.keys(prices).length} live instruments
            </p>
          </div>
          {/* Live indicator */}
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "6px 12px", borderRadius: 99,
            background: C.greenDim, border: `1px solid rgba(0,255,65,0.18)`,
          }}>
            <motion.div
              animate={{ opacity: [1, 0.25, 1] }}
              transition={{ duration: 1.4, repeat: Infinity }}
              style={{ width: 6, height: 6, borderRadius: "50%", background: C.green }}
            />
            <span style={{ color: C.green, fontSize: "0.65rem", fontWeight: 700, letterSpacing: "0.1em" }}>LIVE</span>
          </div>
        </div>

        {/* Search */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "9px 12px", borderRadius: 12, marginBottom: 10,
          background: C.sheet, border: `1px solid ${C.cardBdr}`,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.sub} strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search instruments…"
            style={{
              flex: 1, background: "transparent", border: "none", outline: "none",
              fontSize: "0.82rem", color: C.white, fontFamily: FONT_UI,
            }}
          />
        </div>

        {/* Category filter pills */}
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }}
          className="scrollbar-none">
          {CATEGORIES.map(cat => {
            const active = filter === cat;
            return (
              <motion.button
                key={cat}
                whileTap={{ scale: 0.95 }}
                onClick={() => setFilter(cat)}
                style={{
                  flexShrink:    0,
                  padding:       "5px 14px",
                  borderRadius:  99,
                  fontSize:      "0.68rem",
                  fontWeight:    600,
                  letterSpacing: "0.07em",
                  textTransform: "uppercase",
                  cursor:        "pointer",
                  border:        `1px solid ${active ? C.greenBdr : C.cardBdr}`,
                  background:    active ? C.greenDim : "transparent",
                  color:         active ? C.green : C.sub,
                  boxShadow:     active ? "0 0 10px rgba(0,255,65,0.1)" : "none",
                  fontFamily:    FONT_UI,
                }}
              >
                {cat}
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* ── Instrument list with accordion ────────────────────────────────── */}
      <div style={{ padding: "12px 16px 32px", display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.map(([instrument, meta], index) => {
          const price      = prices[instrument];
          const flicker    = flickerState[instrument];
          const analState  = analysis[instrument];
          const confidence = analState?.confidence ?? 0;
          const bias       = analState?.layer1?.bias ?? "NEUTRAL";
          const isOpen     = openIns === instrument;

          return (
            <motion.div
              key={instrument}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.03, duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
              style={{
                borderRadius: 16,
                overflow:     "hidden",
                background:   C.card,
                border:       `1px solid ${
                  isOpen ? C.greenBdr :
                  confidence === 100 ? "rgba(0,255,65,0.2)" : C.cardBdr
                }`,
                boxShadow:    isOpen
                  ? "0 0 24px rgba(0,255,65,0.07)"
                  : confidence === 100
                  ? "0 0 16px rgba(0,255,65,0.05)"
                  : "none",
              }}
            >
              {/* 100% confidence glow strip */}
              {confidence === 100 && (
                <div style={{
                  height:     2,
                  background: "linear-gradient(90deg, transparent, #00FF41, transparent)",
                  boxShadow:  "0 0 8px rgba(0,255,65,0.5)",
                }} />
              )}

              {/* ── Row header (tappable) ──────────────────────────────── */}
              <motion.div
                whileTap={{ scale: 0.985 }}
                onClick={() => handleRowClick(instrument)}
                style={{
                  display:    "flex",
                  alignItems: "center",
                  gap:        12,
                  padding:    "14px 14px",
                  cursor:     "pointer",
                }}
              >
                {/* Flag icon */}
                <div style={{
                  width:          44,
                  height:         44,
                  borderRadius:   12,
                  display:        "flex",
                  alignItems:     "center",
                  justifyContent: "center",
                  fontSize:       "1.25rem",
                  flexShrink:     0,
                  background:     isOpen ? C.greenDim : "rgba(255,255,255,0.04)",
                  border:         `1px solid ${isOpen ? C.greenBdr : C.cardBdr}`,
                  transition:     "background 0.18s, border-color 0.18s",
                }}>
                  {meta.flag}
                </div>

                {/* Name + category */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: C.white, fontSize: "0.95rem", fontWeight: 600, letterSpacing: "0.02em" }}>
                      {meta.label}
                    </span>
                    {confidence > 0 && <ConfidenceBadge confidence={confidence} bias={bias} />}
                  </div>
                  <span style={{ color: C.label, fontSize: "0.7rem" }}>{meta.category}</span>
                </div>

                {/* Price + chevron */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                  <PriceDisplay price={price} decimals={meta.decimals} flicker={flicker} />
                  <motion.div
                    animate={{ rotate: isOpen ? 180 : 0 }}
                    transition={{ duration: 0.2 }}
                    style={{ color: isOpen ? C.green : C.sub }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </motion.div>
                </div>
              </motion.div>

              {/* ── Inline accordion chart ──────────────────────────────── */}
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.25, ease: [0.32, 0.72, 0, 1] }}
                    style={{ overflow: "hidden" }}
                  >
                    <div style={{
                      margin:       "0 14px 14px",
                      borderRadius: 12,
                      overflow:     "hidden",
                      border:       `1px solid rgba(0,255,65,0.12)`,
                      background:   C.sheet,
                    }}>
                      <InlineChart
                        instrument={instrument}
                        decimals={meta.decimals}
                      />
                      {/* Mini stats bar */}
                      <InlineStats instrument={instrument} analysis={analState} />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  TIMEFRAME CONFIG
//  Maps the button labels to the backend granularity strings and the candle
//  count to request.  M1 = last 120 candles ≈ 2 h; H1 = last 120 ≈ 5 days.
// ─────────────────────────────────────────────────────────────────────────────
const TIMEFRAMES = [
  { label: "1m",  gran: "M1",  count: 120 },
  { label: "5m",  gran: "M5",  count: 120 },
  { label: "15m", gran: "M15", count: 120 },
  { label: "1h",  gran: "H1",  count: 120 },
];

const CHART_H = 280; // candlestick charts need vertical room — responsive on mobile

// ─────────────────────────────────────────────────────────────────────────────
//  InlineChart — LightweightCharts candlestick series
//  • Timeframe selector row above chart (1m / 5m / 15m / 1h)
//  • Radiant colour scheme: up #00FF41 · down #FF3B3B · no borders
//  • Re-creates the chart whenever instrument OR granularity changes
//    (LW-Charts v4 series options are immutable after creation — full remount
//    is the correct pattern when switching data shape)
// ─────────────────────────────────────────────────────────────────────────────
function InlineChart({ instrument, decimals }) {
  const containerRef           = useRef(null);
  const [tfIdx, setTfIdx]      = useState(2); // default: 15m
  const { gran, count }        = TIMEFRAMES[tfIdx];
  const [loading, setLoading]  = useState(false);
  const [noData,  setNoData]   = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    setLoading(true);
    setNoData(false);

    // ── Build chart ─────────────────────────────────────────────────────────
    const chart = createChart(el, {
      width:  el.clientWidth,
      height: CHART_H,
      layout: {
        background:  { color: "transparent" },
        textColor:   C.label,
        fontFamily:  FONT_MONO,
        fontSize:    10,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.03)" },
        horzLines: { color: "rgba(255,255,255,0.03)" },
      },
      rightPriceScale: {
        borderColor: C.cardBdr,
        textColor:   C.sub,
      },
      timeScale: {
        borderColor:    C.cardBdr,
        textColor:      C.sub,
        timeVisible:    true,
        secondsVisible: false,
        fixLeftEdge:    true,
        fixRightEdge:   true,
      },
      crosshair: {
        vertLine: { color: "rgba(0,255,65,0.35)", labelBackgroundColor: "#0f0f0f" },
        horzLine: { color: "rgba(0,255,65,0.35)", labelBackgroundColor: "#0f0f0f" },
      },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true },
      handleScale:  { mouseWheel: false, pinch: true },
    });

    // ── Candlestick series — Radiant theme colours ──────────────────────────
    const series = chart.addCandlestickSeries({
      upColor:          "#00FF41",
      downColor:        "#FF3B3B",
      borderVisible:    false,          // clean, no outlines on bodies
      wickUpColor:      "rgba(0,255,65,0.55)",
      wickDownColor:    "rgba(255,59,59,0.55)",
      priceFormat: {
        type:      "price",
        precision:  decimals,
        minMove:    1 / Math.pow(10, decimals),
      },
    });

    // ── Fetch candles ───────────────────────────────────────────────────────
    api.get(`/markets/${instrument}/candles?granularity=${gran}&count=${count}`)
      .then(({ data }) => {
        // Backend returns { t, o, h, l, c, v }
        const candles = data
          .map(c => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c }))
          .sort((a, b) => a.time - b.time)
          // LW-Charts rejects duplicate timestamps — deduplicate just in case
          .filter((c, i, arr) => i === 0 || c.time !== arr[i - 1].time);

        if (candles.length >= 2) {
          series.setData(candles);
          chart.timeScale().fitContent();
          setNoData(false);
        } else {
          setNoData(true);
        }
      })
      .catch(() => setNoData(true))
      .finally(() => setLoading(false));

    // ── ResizeObserver ──────────────────────────────────────────────────────
    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0) chart.applyOptions({ width: el.clientWidth });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [instrument, decimals, gran, count]); // re-mount on TF change

  return (
    <div>
      {/* ── Timeframe selector ────────────────────────────────────────── */}
      <div style={{
        display:    "flex",
        gap:        4,
        padding:    "8px 10px 6px",
        alignItems: "center",
      }}>
        {TIMEFRAMES.map(({ label }, i) => {
          const active = i === tfIdx;
          return (
            <button
              key={label}
              onClick={() => setTfIdx(i)}
              style={{
                padding:       "3px 10px",
                borderRadius:  7,
                fontSize:      "0.65rem",
                fontWeight:    active ? 700 : 500,
                letterSpacing: "0.06em",
                fontFamily:    FONT_MONO,
                cursor:        "pointer",
                border:        `1px solid ${active ? C.greenBdr : C.cardBdr}`,
                background:    active ? C.greenDim : "transparent",
                color:         active ? C.green : C.sub,
                transition:    "background 0.15s, color 0.15s, border-color 0.15s",
                boxShadow:     active ? "0 0 8px rgba(0,255,65,0.15)" : "none",
              }}
            >
              {label}
            </button>
          );
        })}

        {/* Loading indicator — right-aligned */}
        {loading && (
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}
            style={{
              marginLeft:  "auto",
              width:        12,
              height:       12,
              borderRadius: "50%",
              border:       "2px solid transparent",
              borderTopColor: C.green,
              flexShrink:   0,
            }}
          />
        )}
      </div>

      {/* ── Chart canvas ──────────────────────────────────────────────── */}
      <div style={{ position: "relative" }}>
        <div ref={containerRef} style={{ width: "100%", height: CHART_H }} />

        {/* No-data overlay */}
        {noData && !loading && (
          <div style={{
            position:       "absolute",
            inset:          0,
            display:        "flex",
            alignItems:     "center",
            justifyContent: "center",
            pointerEvents:  "none",
          }}>
            <span style={{ color: C.sub, fontSize: "0.72rem", fontFamily: FONT_UI }}>
              No candle data for {TIMEFRAMES[tfIdx].label}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  InlineStats — mini stat row shown below chart in accordion
// ─────────────────────────────────────────────────────────────────────────────
function InlineStats({ instrument, analysis }) {
  if (!analysis) return null;
  const conf  = analysis.confidence ?? 0;
  const bias  = analysis.layer1?.bias ?? "NEUTRAL";
  const l2    = analysis.layer2?.active ? "✓ OB/FVG" : "—";
  const l3    = analysis.layer3?.mss    ? "✓ MSS"    : "—";
  const color = bias === "BULLISH" ? C.green : bias === "BEARISH" ? C.red : C.sub;

  return (
    <div style={{
      display:             "grid",
      gridTemplateColumns: "repeat(4,1fr)",
      gap:                 1,
      borderTop:           `1px solid ${C.cardBdr}`,
    }}>
      {[
        { label: "Confidence", value: `${conf}%`,  accent: conf === 100 },
        { label: "Bias",       value: bias,          accent: bias !== "NEUTRAL" },
        { label: "L2 Zone",   value: l2 },
        { label: "L3 MSS",    value: l3 },
      ].map(({ label, value, accent }) => (
        <div key={label} style={{
          padding:   "8px 6px",
          textAlign: "center",
          background: "transparent",
        }}>
          <p style={{ color: C.sub, fontSize: "0.55rem", letterSpacing: "0.1em", margin: "0 0 3px", textTransform: "uppercase" }}>
            {label}
          </p>
          <p style={{
            color:      accent ? C.green : C.label,
            fontSize:   "0.68rem",
            fontWeight: 600,
            fontFamily: FONT_MONO,
            margin:     0,
            textShadow: accent ? "0 0 6px rgba(0,255,65,0.5)" : "none",
          }}>
            {value}
          </p>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  PriceDisplay — animated flicker on tick change
// ─────────────────────────────────────────────────────────────────────────────
function PriceDisplay({ price, decimals, flicker }) {
  const color = flicker === "up" ? C.green : flicker === "down" ? C.red : "#d0d0d0";
  const glow  = flicker === "up"
    ? "0 0 10px rgba(0,255,65,0.7)"
    : flicker === "down"
    ? "0 0 10px rgba(255,58,58,0.7)"
    : "none";

  return (
    <motion.span
      animate={{ color, textShadow: glow }}
      transition={{ duration: 0.08 }}
      style={{
        fontSize:   "0.9rem",
        fontWeight: 600,
        fontFamily: FONT_MONO,
        textAlign:  "right",
      }}
    >
      {price !== undefined ? price.toFixed(decimals) : "—"}
    </motion.span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  ConfidenceBadge
// ─────────────────────────────────────────────────────────────────────────────
function ConfidenceBadge({ confidence }) {
  const isFull = confidence === 100;
  const color  = isFull ? C.green : confidence >= 67 ? C.amber : C.red;

  return (
    <motion.span
      animate={isFull
        ? { boxShadow: ["0 0 5px rgba(0,255,65,0.25)", "0 0 12px rgba(0,255,65,0.65)", "0 0 5px rgba(0,255,65,0.25)"] }
        : {}}
      transition={{ duration: 1.6, repeat: Infinity }}
      style={{
        padding:       "2px 7px",
        borderRadius:  6,
        fontSize:      "0.6rem",
        fontWeight:    700,
        letterSpacing: "0.08em",
        background:    `${color}18`,
        border:        `1px solid ${color}40`,
        color,
        fontFamily:    FONT_MONO,
      }}
    >
      {confidence}%
    </motion.span>
  );
}