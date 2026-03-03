/**
 * MarketsPage v3 — Dual-Engine Elite 35
 * ══════════════════════════════════════════════════════════════════════════════
 * FOREX mode  → Oanda: 10 Forex + 3 Metals + 3 Indices (16 total)
 *               Price feed via WebSocket; SMC analysis via REST poll
 * CRYPTO mode → Bybit: 14 Blue-chips + 5 Meme Coins (19 total)
 *               Price + SMC state via GET /api/bybit/market (30 s poll)
 *
 * Architecture rules:
 *   • Oanda state (prices, flickerState, analysis) is NEVER modified in CRYPTO
 *   • Bybit state (bybitPrices, bybitFlicker, bybitAnalysis) is NEVER
 *     touched in FOREX mode
 *   • fetchOandaAnalysis() and fetchBybitMarket() are fully separate functions
 *   • All requests pass X-App-Mode header so backend can log/route
 *   • Strict null-checks on every Bybit field to prevent black-screen crashes
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence }  from "framer-motion";
import { createChart }              from "lightweight-charts";
import { useWebSocket }             from "../hooks/useWebSocket";
import { useAuthStore }             from "../store/authStore";
import { useTheme }                 from "../hooks/useTheme";
import api                          from "../utils/api";

const FONT_UI   = "'Inter', sans-serif";
const FONT_MONO = "'JetBrains Mono', monospace";

const C = {
  red:     "#FF3A3A",
  amber:   "#FFB800",
  white:   "#ffffff",
  label:   "#aaaaaa",
  sub:     "#666666",
  card:    "#0f0f0f",
  cardBdr: "rgba(255,255,255,0.07)",
  sheet:   "#141414",
};

// ── Elite 16: Oanda instrument metadata ────────────────────────────────────────
const OANDA_META = {
  // Forex (10)
  EUR_USD:    { label: "EUR/USD",  flag: "🇪🇺", category: "Forex",   decimals: 5 },
  GBP_USD:    { label: "GBP/USD",  flag: "🇬🇧", category: "Forex",   decimals: 5 },
  USD_JPY:    { label: "USD/JPY",  flag: "🇺🇸", category: "Forex",   decimals: 3 },
  AUD_USD:    { label: "AUD/USD",  flag: "🇦🇺", category: "Forex",   decimals: 5 },
  NZD_USD:    { label: "NZD/USD",  flag: "🇳🇿", category: "Forex",   decimals: 5 },
  USD_CAD:    { label: "USD/CAD",  flag: "🇨🇦", category: "Forex",   decimals: 5 },
  EUR_GBP:    { label: "EUR/GBP",  flag: "🇪🇺", category: "Forex",   decimals: 5 },
  GBP_JPY:    { label: "GBP/JPY",  flag: "🇬🇧", category: "Forex",   decimals: 3 },
  EUR_JPY:    { label: "EUR/JPY",  flag: "🇪🇺", category: "Forex",   decimals: 3 },
  AUD_CAD:    { label: "AUD/CAD",  flag: "🇦🇺", category: "Forex",   decimals: 5 },
  // Metals (3)
  XAU_USD:    { label: "XAU/USD",  flag: "🥇",  category: "Metals",  decimals: 2 },
  XAG_USD:    { label: "XAG/USD",  flag: "🥈",  category: "Metals",  decimals: 3 },
  XPT_USD:    { label: "XPT/USD",  flag: "⚪",  category: "Metals",  decimals: 2 },
  // Indices (3)
  NAS100_USD: { label: "NAS100",   flag: "📈",  category: "Indices", decimals: 1 },
  SPX500_USD: { label: "SPX500",   flag: "📊",  category: "Indices", decimals: 1 },
  US30_USD:   { label: "US30",     flag: "🏛️",  category: "Indices", decimals: 1 },
};
const OANDA_CATEGORIES = ["All", "Forex", "Metals", "Indices"];

// ── Elite 19: Bybit Linear perpetuals metadata ─────────────────────────────────
const BYBIT_META = {
  // Blue-chip L1
  BTCUSDT:       { label: "BTC/USDT",       flag: "₿",   category: "L1",       decimals: 1 },
  ETHUSDT:       { label: "ETH/USDT",       flag: "Ξ",   category: "L1",       decimals: 2 },
  SOLUSDT:       { label: "SOL/USDT",       flag: "◎",   category: "L1",       decimals: 2 },
  BNBUSDT:       { label: "BNB/USDT",       flag: "🔶",  category: "Exchange", decimals: 2 },
  AVAXUSDT:      { label: "AVAX/USDT",      flag: "🔺",  category: "L1",       decimals: 2 },
  ADAUSDT:       { label: "ADA/USDT",       flag: "🔵",  category: "L1",       decimals: 4 },
  DOTUSDT:       { label: "DOT/USDT",       flag: "●",   category: "L1",       decimals: 3 },
  NEARUSDT:      { label: "NEAR/USDT",      flag: "Ⓝ",   category: "L1",       decimals: 3 },
  ATOMUSDT:      { label: "ATOM/USDT",      flag: "⚛",   category: "L1",       decimals: 3 },
  UNIUSDT:       { label: "UNI/USDT",       flag: "🦄",  category: "DeFi",     decimals: 3 },
  // Payments / DeFi
  XRPUSDT:       { label: "XRP/USDT",       flag: "✕",   category: "Payments", decimals: 4 },
  LTCUSDT:       { label: "LTC/USDT",       flag: "Ł",   category: "Payments", decimals: 2 },
  LINKUSDT:      { label: "LINK/USDT",      flag: "⬡",   category: "DeFi",     decimals: 3 },
  DOGEUSDT:      { label: "DOGE/USDT",      flag: "🐶",  category: "Meme",     decimals: 5 },
  // Meme coins
  "1000PEPEUSDT": { label: "1000PEPE",      flag: "🐸",  category: "Meme",     decimals: 6 },
  "1000BONKUSDT": { label: "1000BONK",      flag: "🔥",  category: "Meme",     decimals: 7 },
  FARTCOINUSDT:   { label: "FARTCOIN",      flag: "💨",  category: "Meme",     decimals: 4 },
  XPLUSDT:        { label: "XP/USDT",       flag: "⭐",  category: "Meme",     decimals: 5 },
  WLFIUSDT:       { label: "WLFI/USDT",     flag: "🌊",  category: "Meme",     decimals: 5 },
};
const BYBIT_CATEGORIES = ["All", "L1", "DeFi", "Payments", "Exchange", "Meme"];

// Bybit V5 interval strings
const BYBIT_INTERVAL = { M1: "1", M5: "5", M15: "15", H1: "60" };

// ─────────────────────────────────────────────────────────────────────────────
//  Main component
// ─────────────────────────────────────────────────────────────────────────────
export default function MarketsPage() {
  const { isCrypto, accent, accentHdr, accentDim, accentBdr } = useTheme();
  const appMode = useAuthStore(s => s.appMode);

  // ── Oanda state (FOREX mode) ──────────────────────────────────────────────
  const [prices,        setPrices]        = useState({});
  const [flickerState,  setFlickerState]  = useState({});
  const [analysis,      setAnalysis]      = useState({});
  const [oandaCategory, setOandaCategory] = useState("All");

  // ── Bybit state (CRYPTO mode) ─────────────────────────────────────────────
  const [bybitPrices,   setBybitPrices]   = useState({});
  const [bybitFlicker,  setBybitFlicker]  = useState({});
  const [bybitAnalysis, setBybitAnalysis] = useState({});
  const [bybitMeta,     setBybitMeta]     = useState({});
  const [bybitCategory, setBybitCategory] = useState("All");

  // ── Shared UI state ──────────────────────────────────────────────────────
  const [selectedInstrument, setSelectedInstrument] = useState(null);
  const [granularity,        setGranularity]        = useState("H1");
  const prevPricesRef = useRef({});

  // ── Oanda WebSocket ───────────────────────────────────────────────────────
  const { lastMessage } = useWebSocket(isCrypto ? null : "/ws");

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === "TICK") {
      const ins = lastMessage.instrument;
      const mid = lastMessage.mid;
      if (!ins || !mid) return;
      const prev = prevPricesRef.current[ins];
      if (prev !== undefined && mid !== prev) {
        setFlickerState(f => ({ ...f, [ins]: mid > prev ? "up" : "down" }));
        setTimeout(() => setFlickerState(f => ({ ...f, [ins]: null })), 600);
      }
      prevPricesRef.current[ins] = mid;
      setPrices(p => ({ ...p, [ins]: mid }));
    }
    if (lastMessage.type === "SNAPSHOT") {
      const incoming = lastMessage.prices ?? {};
      prevPricesRef.current = { ...incoming };
      setPrices(incoming);
    }
  }, [lastMessage]);

  // ── Oanda analysis polling (every 30 s in FOREX mode) ────────────────────
  const fetchOandaAnalysis = useCallback(async () => {
    if (isCrypto) return;
    try {
      const { data } = await api.get("/markets", { headers: { "X-App-Mode": "FOREX" } });
      const map = {};
      for (const item of (data ?? [])) {
        map[item.instrument] = item;
      }
      setAnalysis(map);
    } catch { /* non-critical */ }
  }, [isCrypto]);

  useEffect(() => {
    if (isCrypto) return;
    fetchOandaAnalysis();
    const id = setInterval(fetchOandaAnalysis, 30_000);
    return () => clearInterval(id);
  }, [isCrypto, fetchOandaAnalysis]);

  // ── Bybit market polling (GET /api/bybit/market, 30 s in CRYPTO mode) ────
  const fetchBybitMarket = useCallback(async () => {
    if (!isCrypto) return;
    try {
      const { data } = await api.get("/bybit/market", { headers: { "X-App-Mode": "CRYPTO" } });
      const priceMap    = {};
      const analysisMap = {};
      const metaMap     = {};
      for (const item of (data ?? [])) {
        const sym = item.symbol;
        if (!sym) continue;
        const prev = prevPricesRef.current[sym];
        if (prev !== undefined && item.price !== prev) {
          setBybitFlicker(f => ({ ...f, [sym]: item.price > prev ? "up" : "down" }));
          setTimeout(() => setBybitFlicker(f => ({ ...f, [sym]: null })), 600);
        }
        prevPricesRef.current[sym] = item.price;
        priceMap[sym]    = item.price;
        analysisMap[sym] = item;
        metaMap[sym]     = { high24h: item.high24h, low24h: item.low24h, volume24h: item.volume24h, change24h: item.change24h };
      }
      setBybitPrices(p    => ({ ...p,    ...priceMap    }));
      setBybitAnalysis(a  => ({ ...a,    ...analysisMap }));
      setBybitMeta(m      => ({ ...m,    ...metaMap     }));
    } catch { /* non-critical */ }
  }, [isCrypto]);

  useEffect(() => {
    if (!isCrypto) return;
    prevPricesRef.current = {};
    fetchBybitMarket();
    const id = setInterval(fetchBybitMarket, 30_000);
    return () => clearInterval(id);
  }, [isCrypto, fetchBybitMarket]);

  // ── Mode switch: clear selected instrument + reset category ──────────────
  useEffect(() => {
    setSelectedInstrument(null);
    setOandaCategory("All");
    setBybitCategory("All");
    prevPricesRef.current = {};
  }, [isCrypto]);

  // ── Active meta / categories / prices depending on mode ──────────────────
  const activeMeta       = isCrypto ? BYBIT_META       : OANDA_META;
  const activeCategories = isCrypto ? BYBIT_CATEGORIES : OANDA_CATEGORIES;
  const activeCategory   = isCrypto ? bybitCategory    : oandaCategory;
  const setActiveCategory = isCrypto ? setBybitCategory : setOandaCategory;
  const activePrices     = isCrypto ? bybitPrices      : prices;
  const activeFlicker    = isCrypto ? bybitFlicker      : flickerState;
  const activeAnalysis   = isCrypto ? bybitAnalysis     : analysis;

  // Filter by category
  const filteredInstruments = Object.keys(activeMeta).filter(key => {
    if (activeCategory === "All") return true;
    return activeMeta[key]?.category === activeCategory;
  });

  // Live count (have a price)
  const liveCount = filteredInstruments.filter(k => (activePrices[k] ?? 0) > 0).length;

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
        <div style={{ padding: "14px 16px 0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1 style={{ color: C.white, fontSize: "1.2rem", fontWeight: 700, letterSpacing: "0.03em", margin: "0 0 2px" }}>
              Markets
            </h1>
            <p style={{ color: C.sub, fontSize: "0.62rem", margin: 0, fontFamily: FONT_MONO }}>
              {liveCount} live · {isCrypto ? "Bybit Linear Futures" : "Oanda v20"}
            </p>
          </div>
        </div>

        {/* Category tabs */}
        <div style={{ display: "flex", padding: "8px 16px 0", gap: 8, overflowX: "auto" }}>
          {activeCategories.map(cat => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              style={{
                flexShrink: 0, padding: "6px 14px",
                borderRadius: 99,
                background:  activeCategory === cat ? accentDim : "rgba(255,255,255,0.04)",
                border:      `1px solid ${activeCategory === cat ? accentBdr : C.cardBdr}`,
                color:       activeCategory === cat ? accent : C.sub,
                fontSize:    "0.65rem", fontWeight: activeCategory === cat ? 700 : 400,
                cursor:      "pointer", transition: "all 0.2s",
                WebkitTapHighlightColor: "transparent",
              }}
            >{cat}</button>
          ))}
        </div>
        <div style={{ height: 8 }} />
      </div>

      {/* ── Instrument list ─────────────────────────────────────────────── */}
      <div style={{ padding: "8px 16px 16px", display: "flex", flexDirection: "column", gap: 2 }}>
        {filteredInstruments.map(instrument => {
          const meta     = activeMeta[instrument] ?? {};
          const price    = activePrices[instrument] ?? 0;
          const flicker  = activeFlicker[instrument];
          const state    = activeAnalysis[instrument];
          const conf     = state?.confidence ?? 0;
          const bias     = state?.bias ?? "NEUTRAL";
          const change24 = isCrypto ? (bybitMeta[instrument]?.change24h ?? null) : null;
          const isSelected = selectedInstrument === instrument;

          return (
            <motion.div
              key={instrument}
              layout
              onClick={() => setSelectedInstrument(isSelected ? null : instrument)}
              style={{
                borderRadius:  14,
                background:    isSelected ? accentDim : "transparent",
                border:        `1px solid ${isSelected ? accentBdr : "transparent"}`,
                cursor:        "pointer",
                overflow:      "hidden",
                transition:    "background 0.2s, border-color 0.2s",
              }}
            >
              {/* ── Row ───────────────────────────────────────────────── */}
              <div style={{
                display: "flex", alignItems: "center", gap: 12, padding: "12px 12px",
              }}>
                {/* Flag / icon */}
                <div style={{
                  width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: "1.1rem",
                  background: isSelected ? `${accent}15` : "rgba(255,255,255,0.04)",
                  border:     `1px solid ${isSelected ? accentBdr : C.cardBdr}`,
                }}>
                  {meta.flag ?? "?"}
                </div>

                {/* Label + category */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ color: C.white, fontSize: "0.88rem", fontWeight: 600, margin: "0 0 2px", fontFamily: FONT_MONO }}>
                    {meta.label ?? instrument}
                  </p>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ color: C.sub, fontSize: "0.6rem" }}>{meta.category}</span>
                    {conf > 0 && (
                      <ConfBadge conf={conf} bias={bias} accent={accent} />
                    )}
                  </div>
                </div>

                {/* Price + change */}
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <motion.p
                    animate={{
                      color: flicker === "up" ? C.green : flicker === "down" ? C.red : C.white,
                    }}
                    transition={{ duration: 0.15 }}
                    style={{ fontSize: "0.92rem", fontWeight: 700, fontFamily: FONT_MONO, margin: 0 }}
                  >
                    {price > 0 ? price.toFixed(meta.decimals ?? 5) : "—"}
                  </motion.p>
                  {change24 != null && (
                    <p style={{
                      fontSize: "0.6rem", margin: "2px 0 0",
                      color: change24 >= 0 ? C.green : C.red,
                      fontFamily: FONT_MONO,
                    }}>
                      {change24 >= 0 ? "+" : ""}{change24.toFixed(2)}%
                    </p>
                  )}
                </div>
              </div>

              {/* ── Expanded chart ────────────────────────────────────── */}
              <AnimatePresence>
                {isSelected && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.25 }}
                    style={{ overflow: "hidden" }}
                  >
                    <InlineChart
                      instrument={instrument}
                      isCrypto={isCrypto}
                      granularity={granularity}
                      setGranularity={setGranularity}
                      accent={accent}
                      meta={meta}
                      analysis={activeAnalysis[instrument]}
                    />
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

// ── ConfBadge ─────────────────────────────────────────────────────────────────
function ConfBadge({ conf, bias, accent }) {
  const color = conf >= 100 ? accent : conf >= 80 ? C.amber : C.sub;
  return (
    <span style={{
      fontSize: "0.55rem", fontWeight: 700, padding: "1px 6px", borderRadius: 5,
      background: `${color}12`, border: `1px solid ${color}28`,
      color, fontFamily: FONT_MONO, letterSpacing: "0.06em",
    }}>
      {conf}% {bias !== "NEUTRAL" ? bias.substring(0, 4) : ""}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  InlineChart — candlestick for both Oanda and Bybit
// ─────────────────────────────────────────────────────────────────────────────
function InlineChart({ instrument, isCrypto, granularity, setGranularity, accent, meta, analysis }) {
  const chartRef      = useRef(null);
  const chartInstance = useRef(null);
  const seriesRef     = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  const OANDA_GRAN  = ["M1", "M5", "M15", "H1"];
  const BYBIT_GRAN  = ["M1", "M5", "M15", "H1"];
  const grans       = isCrypto ? BYBIT_GRAN : OANDA_GRAN;

  useEffect(() => {
    if (!chartRef.current) return;
    const chart = createChart(chartRef.current, {
      width:  chartRef.current.clientWidth,
      height: 220,
      layout:      { background: { color: "transparent" }, textColor: C.sub },
      grid:        { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      crosshair:   { mode: 1 },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.1)" },
      timeScale:       { borderColor: "rgba(255,255,255,0.1)", timeVisible: true, secondsVisible: false },
    });
    const series = chart.addCandlestickSeries({
      upColor:    accent,
      downColor:  C.red,
      borderUpColor:   accent,
      borderDownColor: C.red,
      wickUpColor:     accent,
      wickDownColor:   C.red,
    });
    chartInstance.current = chart;
    seriesRef.current     = series;

    const ro = new ResizeObserver(() => {
      if (chartRef.current) chart.applyOptions({ width: chartRef.current.clientWidth });
    });
    ro.observe(chartRef.current);
    return () => { ro.disconnect(); chart.remove(); };
  }, []); // eslint-disable-line

  useEffect(() => {
    if (!seriesRef.current) return;
    setLoading(true);
    setError(null);

    const bybitInterval = BYBIT_INTERVAL[granularity] ?? "60";
    const endpoint = isCrypto
      ? `/bybit/candles/${instrument}?interval=${bybitInterval}&limit=120`
      : `/markets/${instrument}/candles?granularity=${granularity}&count=120`;

    api.get(endpoint)
      .then(({ data }) => {
        if (!data?.length) return;
        const formatted = data.map(c => ({
          time:  c.t,
          open:  parseFloat(c.o),
          high:  parseFloat(c.h),
          low:   parseFloat(c.l),
          close: parseFloat(c.c),
        })).filter(c => c.open && c.high && c.low && c.close);
        seriesRef.current.setData(formatted);
        chartInstance.current.timeScale().fitContent();
        setLoading(false);
      })
      .catch(() => { setError("Could not load candles"); setLoading(false); });
  }, [instrument, granularity, isCrypto]); // eslint-disable-line

  return (
    <div style={{ padding: "0 12px 14px" }}>
      {/* Granularity selector */}
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {grans.map(g => (
          <button
            key={g}
            onClick={e => { e.stopPropagation(); setGranularity(g); }}
            style={{
              padding: "4px 10px", borderRadius: 7, cursor: "pointer",
              background: granularity === g ? `${accent}18` : "rgba(255,255,255,0.04)",
              border:     `1px solid ${granularity === g ? `${accent}35` : C.cardBdr}`,
              color:      granularity === g ? accent : C.sub,
              fontSize:   "0.6rem", fontWeight: 700, fontFamily: FONT_MONO,
              WebkitTapHighlightColor: "transparent",
            }}
          >{g}</button>
        ))}
        {/* SMC analysis summary */}
        {analysis && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
            {analysis.layer2 && <MiniTag label="OB/FVG" accent={accent} />}
            {analysis.layer3 && <MiniTag label="MSS"    accent={accent} />}
          </div>
        )}
      </div>

      {/* Chart container */}
      <div style={{ position: "relative", borderRadius: 10, overflow: "hidden" }}>
        <div ref={chartRef} style={{ width: "100%" }} />
        {loading && (
          <div style={{
            position: "absolute", inset: 0, background: "rgba(0,0,0,0.6)",
            display: "flex", alignItems: "center", justifyContent: "center",
            borderRadius: 10,
          }}>
            <p style={{ color: C.sub, fontSize: "0.72rem", fontFamily: FONT_MONO }}>Loading candles…</p>
          </div>
        )}
        {error && (
          <div style={{
            position: "absolute", inset: 0, background: "rgba(0,0,0,0.6)",
            display: "flex", alignItems: "center", justifyContent: "center",
            borderRadius: 10,
          }}>
            <p style={{ color: C.red, fontSize: "0.72rem" }}>{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function MiniTag({ label, accent }) {
  return (
    <span style={{
      fontSize: "0.55rem", fontWeight: 700, padding: "2px 6px", borderRadius: 5,
      background: `${accent}10`, border: `1px solid ${accent}25`,
      color: accent, fontFamily: FONT_MONO,
    }}>{label}</span>
  );
}