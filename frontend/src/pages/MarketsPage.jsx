/**
 * MarketsPage — Dual-Engine
 * ══════════════════════════════════════════════════════════════
 * FOREX mode  → Oanda instruments via WebSocket ticks + SMC analysis polling
 * CRYPTO mode → MEXC perpetuals via REST polling (/api/mexc/market)
 *
 * Architecture rules:
 *  • OANDA state (prices, flickerState, analysis) is NEVER modified in CRYPTO
 *  • MEXC state (cryptoPrices, cryptoFlicker, cryptoAnalysis) is NEVER
 *    touched in FOREX mode
 *  • fetchOandaAnalysis() and fetchMexcMarket() are fully separate functions
 *  • All requests pass X-App-Mode header so backend can log/route
 *  • Strict null-checks on every MEXC field to prevent black-screen crashes
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

// ── Non-accent design tokens (same in both modes) ─────────────────────────────
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

// ── OANDA instrument metadata (UNCHANGED) ─────────────────────────────────────
const OANDA_META = {
  EUR_USD:    { label: "EUR/USD",  flag: "🇪🇺", category: "Forex",   decimals: 5 },
  GBP_USD:    { label: "GBP/USD",  flag: "🇬🇧", category: "Forex",   decimals: 5 },
  USD_JPY:    { label: "USD/JPY",  flag: "🇺🇸", category: "Forex",   decimals: 3 },
  AUD_USD:    { label: "AUD/USD",  flag: "🇦🇺", category: "Forex",   decimals: 5 },
  NZD_USD:    { label: "NZD/USD",  flag: "🇳🇿", category: "Forex",   decimals: 5 },
  USD_CAD:    { label: "USD/CAD",  flag: "🇨🇦", category: "Forex",   decimals: 5 },
  USD_CHF:    { label: "USD/CHF",  flag: "🇨🇭", category: "Forex",   decimals: 5 },
  XAU_USD:    { label: "XAU/USD",  flag: "🥇",  category: "Metals",  decimals: 2 },
  NAS100_USD: { label: "NAS100",   flag: "📈",  category: "Indices", decimals: 1 },
  US30_USD:   { label: "US30",     flag: "🏛️",  category: "Indices", decimals: 1 },
  SPX500_USD: { label: "SPX500",   flag: "📊",  category: "Indices", decimals: 1 },
  GER30_EUR:  { label: "GER30",    flag: "🇩🇪", category: "Indices", decimals: 1 },
  UK100_GBP:  { label: "UK100",    flag: "🇬🇧", category: "Indices", decimals: 1 },
  J225_USD:   { label: "J225",     flag: "🇯🇵", category: "Indices", decimals: 0 },
  BTC_USD:    { label: "BTC/USD",  flag: "₿",   category: "Crypto",  decimals: 1 },
};
const OANDA_CATEGORIES = ["All", "Forex", "Metals", "Indices", "Crypto"];

// ── MEXC instrument metadata — 15 most-traded perpetuals ────────────────────
const MEXC_META = {
  BTCUSDT:   { label: "BTC/USDT",  flag: "₿",   category: "L1",       decimals: 1 },
  ETHUSDT:   { label: "ETH/USDT",  flag: "Ξ",   category: "L1",       decimals: 2 },
  SOLUSDT:   { label: "SOL/USDT",  flag: "◎",   category: "L1",       decimals: 2 },
  XRPUSDT:   { label: "XRP/USDT",  flag: "✕",   category: "Payments", decimals: 4 },
  BNBUSDT:   { label: "BNB/USDT",  flag: "🔶",  category: "Exchange", decimals: 2 },
  DOGEUSDT:  { label: "DOGE/USDT", flag: "🐶",  category: "Meme",     decimals: 5 },
  ADAUSDT:   { label: "ADA/USDT",  flag: "🔵",  category: "L1",       decimals: 4 },
  AVAXUSDT:  { label: "AVAX/USDT", flag: "🔺",  category: "L1",       decimals: 2 },
  LINKUSDT:  { label: "LINK/USDT", flag: "⬡",   category: "DeFi",     decimals: 3 },
  DOTUSDT:   { label: "DOT/USDT",  flag: "●",   category: "L1",       decimals: 3 },
  MATICUSDT: { label: "MATIC/USDT",flag: "🟣",  category: "L2",       decimals: 4 },
  LTCUSDT:   { label: "LTC/USDT",  flag: "Ł",   category: "Payments", decimals: 2 },
  UNIUSDT:   { label: "UNI/USDT",  flag: "🦄",  category: "DeFi",     decimals: 3 },
  ATOMUSDT:  { label: "ATOM/USDT", flag: "⚛",   category: "L1",       decimals: 3 },
  NEARUSDT:  { label: "NEAR/USDT", flag: "Ⓝ",   category: "L1",       decimals: 3 },
};
const MEXC_CATEGORIES = ["All", "L1", "L2", "DeFi", "Payments", "Exchange", "Meme"];

// MEXC granularity → interval string (REST kline API)
const MEXC_INTERVAL = { M1: "1m", M5: "5m", M15: "15m", H1: "1h" };

// ═════════════════════════════════════════════════════════════════════════════
export default function MarketsPage() {
  const { isCrypto, accent, accentDim, accentBdr, accentGlow } = useTheme();

  // ── OANDA engine state (never mutated in CRYPTO mode) ─────────────────────
  const [prices,       setPrices]    = useState({});
  const [flickerState, setFlicker]   = useState({});
  const [analysis,     setAnalysis]  = useState({});

  // ── MEXC engine state (never mutated in FOREX mode) ──────────────────────
  const [cryptoPrices,   setCryptoPrices]   = useState({});
  const [cryptoFlicker,  setCryptoFlicker]  = useState({});
  const [cryptoMeta,     setCryptoMeta]     = useState({});  // 24h stats from MEXC

  const tickerRef      = useRef({});
  const cryptoTickRef  = useRef({});
  const prevCryptoRef  = useRef({});

  const [openIns,  setOpenIns]  = useState(null);
  const [filter,   setFilter]   = useState("All");
  const [search,   setSearch]   = useState("");

  const { lastMessage, send } = useWebSocket();

  // ── Reset accordion + filter when mode switches ────────────────────────────
  useEffect(() => {
    setOpenIns(null);
    setFilter("All");
    setSearch("");
  }, [isCrypto]);

  // ── OANDA: WebSocket price ticks (FOREX only) ─────────────────────────────
  useEffect(() => {
    if (isCrypto) return;  // ← isolated: never runs in CRYPTO mode
    if (openIns) send({ type: "SUBSCRIBE", instrument: openIns });
  }, [openIns, send, isCrypto]);

  useEffect(() => {
    if (isCrypto || !lastMessage) return;
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
  }, [lastMessage, isCrypto]);

  // ── OANDA: SMC analysis polling — split into its own function ─────────────
  const fetchOandaAnalysis = useCallback(async () => {
    const keys    = Object.keys(OANDA_META);
    const headers = { "X-App-Mode": "FOREX" };
    const results = await Promise.allSettled(
      keys.map(k => api.get(`/markets/${k}/analysis`, { headers }))
    );
    const merged = {};
    keys.forEach((k, i) => {
      if (results[i].status === "fulfilled") merged[k] = results[i].value.data ?? {};
    });
    setAnalysis(merged);
  }, []);

  useEffect(() => {
    if (isCrypto) return;  // ← isolated: never runs in CRYPTO mode
    fetchOandaAnalysis();
    const id = setInterval(fetchOandaAnalysis, 30_000);
    return () => clearInterval(id);
  }, [isCrypto, fetchOandaAnalysis]);

  // ── MEXC: market data polling — split into its own function ──────────────
  const fetchMexcMarket = useCallback(async () => {
    try {
      const { data } = await api.get("/mexc/market", {
        headers: { "X-App-Mode": "CRYPTO" },
      });
      if (!Array.isArray(data)) return;

      const newPrices = {};
      const newMeta   = {};

      data.forEach(item => {
        const sym = item?.symbol ?? null;
        if (!sym) return;
        const price = typeof item.price === "number" ? item.price : 0;
        newPrices[sym] = price;
        newMeta[sym]   = {
          change24h:  typeof item.change24h  === "number" ? item.change24h  : 0,
          volume24h:  typeof item.volume24h  === "number" ? item.volume24h  : 0,
          high24h:    typeof item.high24h    === "number" ? item.high24h    : 0,
          low24h:     typeof item.low24h     === "number" ? item.low24h     : 0,
          confidence: typeof item.confidence === "number" ? item.confidence : 0,
          bias:       typeof item.bias       === "string" ? item.bias       : "NEUTRAL",
        };

        // Flicker detection vs previous poll
        const prev = prevCryptoRef.current[sym];
        if (prev !== undefined && price !== prev) {
          const dir = price > prev ? "up" : "down";
          setCryptoFlicker(f => ({ ...f, [sym]: dir }));
          clearTimeout(cryptoTickRef.current[sym]);
          cryptoTickRef.current[sym] = setTimeout(() =>
            setCryptoFlicker(f => ({ ...f, [sym]: null })), 500);
        }
      });

      prevCryptoRef.current = newPrices;
      setCryptoPrices(newPrices);
      setCryptoMeta(newMeta);
    } catch {
      // Non-fatal — keep showing stale prices
    }
  }, []);

  useEffect(() => {
    if (!isCrypto) return;  // ← isolated: never runs in FOREX mode
    fetchMexcMarket();
    const id = setInterval(fetchMexcMarket, 30_000);
    return () => clearInterval(id);
  }, [isCrypto, fetchMexcMarket]);

  // ── Active state based on mode ────────────────────────────────────────────
  const activeMeta       = isCrypto ? MEXC_META       : OANDA_META;
  const activeCategories = isCrypto ? MEXC_CATEGORIES : OANDA_CATEGORIES;
  const activePrices     = isCrypto ? cryptoPrices      : prices;
  const activeFlicker    = isCrypto ? cryptoFlicker     : flickerState;
  const activeAnalysis   = isCrypto ? cryptoMeta        : analysis;

  const liveCount = Object.keys(activePrices).filter(k => activePrices[k] > 0).length;

  const filtered = Object.entries(activeMeta).filter(([key, meta]) => {
    const catOk  = filter === "All" || meta.category === filter;
    const srchOk = meta.label.toLowerCase().includes(search.toLowerCase());
    return catOk && srchOk;
  });

  const handleRowClick = useCallback((ins) => {
    setOpenIns(prev => prev === ins ? null : ins);
  }, []);

  return (
    <div style={{ fontFamily: FONT_UI, color: C.white, minHeight: "100%" }}>

      {/* ── Sticky page sub-header ──────────────────────────────────────── */}
      <div style={{
        position:             "sticky",
        top:                  0,
        zIndex:               20,
        padding:              "14px 16px 12px",
        background:           "rgba(5,5,5,0.97)",
        backdropFilter:       "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderBottom:         `1px solid ${accent}14`,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <h1 style={{ color: C.white, fontSize: "1.2rem", fontWeight: 700, letterSpacing: "0.03em", margin: 0 }}>
              {isCrypto ? "Crypto" : "Markets"}
            </h1>
            <p style={{ color: C.label, fontSize: "0.7rem", margin: "2px 0 0" }}>
              {liveCount} live · {isCrypto ? "MEXC Spot" : "Oanda v20"}
            </p>
          </div>
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
            <span style={{ color: accent, fontSize: "0.65rem", fontWeight: 700, letterSpacing: "0.1em" }}>LIVE</span>
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
            placeholder={isCrypto ? "Search coins…" : "Search instruments…"}
            style={{
              flex: 1, background: "transparent", border: "none", outline: "none",
              fontSize: "0.82rem", color: C.white, fontFamily: FONT_UI,
            }}
          />
        </div>

        {/* Category filter pills */}
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }}>
          {activeCategories.map(cat => {
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
                  border:        `1px solid ${active ? accentBdr : C.cardBdr}`,
                  background:    active ? accentDim : "transparent",
                  color:         active ? accent    : C.sub,
                  boxShadow:     active ? `0 0 10px ${accentGlow}` : "none",
                  fontFamily:    FONT_UI,
                }}
              >
                {cat}
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* ── Instrument list ────────────────────────────────────────────────── */}
      <div style={{ padding: "12px 16px 32px", display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.map(([instrument, meta], index) => {
          const price      = activePrices[instrument] ?? undefined;
          const flicker    = activeFlicker[instrument] ?? null;
          const analState  = activeAnalysis[instrument] ?? {};
          const confidence = analState?.confidence ?? 0;
          const bias       = analState?.bias ?? analState?.layer1?.bias ?? "NEUTRAL";
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
                  isOpen      ? accentBdr :
                  confidence === 100 ? `${accent}33` : C.cardBdr
                }`,
                boxShadow: isOpen
                  ? `0 0 24px ${accentGlow}`
                  : confidence === 100
                  ? `0 0 16px ${accent}0d`
                  : "none",
              }}
            >
              {confidence === 100 && (
                <div style={{
                  height:    2,
                  background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
                  boxShadow:  `0 0 8px ${accent}80`,
                }} />
              )}

              {/* Tappable row */}
              <motion.div
                whileTap={{ scale: 0.985 }}
                onClick={() => handleRowClick(instrument)}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 14px", cursor: "pointer" }}
              >
                <div style={{
                  width: 44, height: 44, borderRadius: 12, flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: "1.25rem",
                  background: isOpen ? accentDim : "rgba(255,255,255,0.04)",
                  border:     `1px solid ${isOpen ? accentBdr : C.cardBdr}`,
                  transition: "background 0.18s, border-color 0.18s",
                }}>
                  {meta.flag}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: C.white, fontSize: "0.95rem", fontWeight: 600 }}>
                      {meta.label}
                    </span>
                    {confidence > 0 && <ConfidenceBadge confidence={confidence} accent={accent} />}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ color: C.label, fontSize: "0.7rem" }}>{meta.category}</span>
                    {isCrypto && typeof analState?.change24h === "number" && (
                      <span style={{
                        fontSize: "0.65rem", fontFamily: FONT_MONO,
                        color: analState.change24h >= 0 ? "#00FF41" : C.red,
                      }}>
                        {analState.change24h >= 0 ? "+" : ""}{analState.change24h.toFixed(2)}%
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                  <PriceDisplay price={price} decimals={meta.decimals} flicker={flicker} />
                  <motion.div
                    animate={{ rotate: isOpen ? 180 : 0 }}
                    transition={{ duration: 0.2 }}
                    style={{ color: isOpen ? accent : C.sub }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </motion.div>
                </div>
              </motion.div>

              {/* Accordion chart */}
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
                      margin: "0 14px 14px", borderRadius: 12, overflow: "hidden",
                      border: `1px solid ${accent}1f`, background: C.sheet,
                    }}>
                      <InlineChart
                        instrument={instrument}
                        decimals={meta.decimals}
                        isCrypto={isCrypto}
                        accent={accent}
                        accentDim={accentDim}
                        accentBdr={accentBdr}
                      />
                      <InlineStats
                        analysis={analState}
                        isCrypto={isCrypto}
                        accent={accent}
                      />
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

// ── Timeframe config ──────────────────────────────────────────────────────────
const TIMEFRAMES = [
  { label: "1m",  gran: "M1",  count: 120 },
  { label: "5m",  gran: "M5",  count: 120 },
  { label: "15m", gran: "M15", count: 120 },
  { label: "1h",  gran: "H1",  count: 120 },
];

const CHART_H = 280;

// ─────────────────────────────────────────────────────────────────────────────
//  InlineChart — candlestick chart for BOTH Oanda & MEXC
//  • isCrypto=false → /markets/{instrument}/candles (Oanda)
//  • isCrypto=true  → /mexc/candles/{symbol}?interval={mexcInterval}
// ─────────────────────────────────────────────────────────────────────────────
function InlineChart({ instrument, decimals, isCrypto, accent, accentDim, accentBdr }) {
  const containerRef          = useRef(null);
  const [tfIdx, setTfIdx]     = useState(2);   // default: 15m
  const { gran, count }       = TIMEFRAMES[tfIdx];
  const [loading, setLoading] = useState(false);
  const [noData,  setNoData]  = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    setLoading(true);
    setNoData(false);

    const chart = createChart(el, {
      width:  el.clientWidth,
      height: CHART_H,
      layout: {
        background: { color: "transparent" },
        textColor:  C.label,
        fontFamily: FONT_MONO,
        fontSize:   10,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.03)" },
        horzLines: { color: "rgba(255,255,255,0.03)" },
      },
      rightPriceScale: { borderColor: C.cardBdr, textColor: C.sub },
      timeScale: {
        borderColor: C.cardBdr, textColor: C.sub,
        timeVisible: true, secondsVisible: false,
        fixLeftEdge: true, fixRightEdge: true,
      },
      crosshair: {
        vertLine: { color: `${accent}59`, labelBackgroundColor: "#0f0f0f" },
        horzLine: { color: `${accent}59`, labelBackgroundColor: "#0f0f0f" },
      },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true },
      handleScale:  { mouseWheel: false, pinch: true },
    });

    const series = chart.addCandlestickSeries({
      upColor:       accent,
      downColor:     "#FF3B3B",
      borderVisible: false,
      wickUpColor:   `${accent}8c`,
      wickDownColor: "rgba(255,59,59,0.55)",
      priceFormat: {
        type:      "price",
        precision:  decimals,
        minMove:    1 / Math.pow(10, decimals),
      },
    });

    // Build endpoint: Oanda or MEXC
    const endpoint = isCrypto
      ? `/mexc/candles/${instrument}?interval=${MEXC_INTERVAL[gran] ?? "1h"}&limit=${count}`
      : `/markets/${instrument}/candles?granularity=${gran}&count=${count}`;

    const headers = { "X-App-Mode": isCrypto ? "CRYPTO" : "FOREX" };

    api.get(endpoint, { headers })
      .then(({ data }) => {
        if (!Array.isArray(data) || data.length < 2) { setNoData(true); return; }
        const candles = data
          .map(c => {
            // Strict null-checks on every field — prevents black-screen crash
            const t = typeof c?.t === "number" ? c.t : null;
            const o = typeof c?.o === "number" ? c.o : null;
            const h = typeof c?.h === "number" ? c.h : null;
            const l = typeof c?.l === "number" ? c.l : null;
            const cl = typeof c?.c === "number" ? c.c : null;
            if (t === null || o === null || h === null || l === null || cl === null) return null;
            return { time: t, open: o, high: h, low: l, close: cl };
          })
          .filter(Boolean)
          .sort((a, b) => a.time - b.time)
          .filter((c, i, arr) => i === 0 || c.time !== arr[i - 1].time);

        if (candles.length < 2) { setNoData(true); return; }
        series.setData(candles);
        chart.timeScale().fitContent();
        setNoData(false);
      })
      .catch(() => setNoData(true))
      .finally(() => setLoading(false));

    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0) chart.applyOptions({ width: el.clientWidth });
    });
    ro.observe(el);

    return () => { ro.disconnect(); chart.remove(); };
  }, [instrument, decimals, gran, count, isCrypto, accent]);

  return (
    <div>
      {/* Timeframe selector */}
      <div style={{ display: "flex", gap: 4, padding: "8px 10px 6px", alignItems: "center" }}>
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
                border:        `1px solid ${active ? accentBdr : C.cardBdr}`,
                background:    active ? accentDim : "transparent",
                color:         active ? accent    : C.sub,
                transition:    "background 0.15s, color 0.15s, border-color 0.15s",
                boxShadow:     active ? `0 0 8px ${accent}26` : "none",
              }}
            >
              {label}
            </button>
          );
        })}
        {loading && (
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}
            style={{
              marginLeft: "auto", width: 12, height: 12, borderRadius: "50%",
              border: "2px solid transparent", borderTopColor: accent, flexShrink: 0,
            }}
          />
        )}
      </div>

      <div style={{ position: "relative" }}>
        <div ref={containerRef} style={{ width: "100%", height: CHART_H }} />
        {noData && !loading && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            pointerEvents: "none",
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
//  InlineStats — mini stat row below chart
//  FOREX: confidence + SMC layer breakdown
//  CRYPTO: 24h high / low / volume
// ─────────────────────────────────────────────────────────────────────────────
function InlineStats({ analysis, isCrypto, accent }) {
  if (!analysis || Object.keys(analysis).length === 0) return null;

  if (isCrypto) {
    // MEXC 24h stats
    const h24  = typeof analysis.high24h   === "number" ? analysis.high24h  : null;
    const l24  = typeof analysis.low24h    === "number" ? analysis.low24h   : null;
    const vol  = typeof analysis.volume24h === "number" ? analysis.volume24h : null;
    const chg  = typeof analysis.change24h === "number" ? analysis.change24h : null;

    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 1, borderTop: `1px solid ${C.cardBdr}` }}>
        {[
          { label: "24h High",   value: h24 !== null ? h24.toLocaleString()  : "—" },
          { label: "24h Low",    value: l24 !== null ? l24.toLocaleString()  : "—" },
          { label: "Volume",     value: vol !== null ? (vol / 1e6).toFixed(1) + "M" : "—" },
          { label: "24h Change", value: chg !== null ? `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%` : "—",
            accent: chg !== null && chg !== 0 },
        ].map(({ label, value, accent: isAccent }) => (
          <div key={label} style={{ padding: "8px 6px", textAlign: "center" }}>
            <p style={{ color: C.sub, fontSize: "0.55rem", letterSpacing: "0.1em", margin: "0 0 3px", textTransform: "uppercase" }}>
              {label}
            </p>
            <p style={{
              color:      isAccent ? accent : C.label,
              fontSize:   "0.68rem", fontWeight: 600, fontFamily: FONT_MONO, margin: 0,
              textShadow: isAccent ? `0 0 6px ${accent}80` : "none",
            }}>
              {value}
            </p>
          </div>
        ))}
      </div>
    );
  }

  // Oanda SMC stats
  const conf  = analysis.confidence ?? 0;
  const bias  = analysis.layer1?.bias ?? analysis.bias ?? "NEUTRAL";
  const l2    = analysis.layer2?.active ? "✓ OB/FVG" : "—";
  const l3    = analysis.layer3?.mss    ? "✓ MSS"    : "—";

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 1, borderTop: `1px solid ${C.cardBdr}` }}>
      {[
        { label: "Confidence", value: `${conf}%`,  isAccent: conf === 100 },
        { label: "Bias",       value: bias,          isAccent: bias !== "NEUTRAL" },
        { label: "L2 Zone",   value: l2 },
        { label: "L3 MSS",    value: l3 },
      ].map(({ label, value, isAccent }) => (
        <div key={label} style={{ padding: "8px 6px", textAlign: "center" }}>
          <p style={{ color: C.sub, fontSize: "0.55rem", letterSpacing: "0.1em", margin: "0 0 3px", textTransform: "uppercase" }}>
            {label}
          </p>
          <p style={{
            color:      isAccent ? accent : C.label,
            fontSize:   "0.68rem", fontWeight: 600, fontFamily: FONT_MONO, margin: 0,
            textShadow: isAccent ? `0 0 6px ${accent}80` : "none",
          }}>
            {value}
          </p>
        </div>
      ))}
    </div>
  );
}

// ── PriceDisplay ──────────────────────────────────────────────────────────────
function PriceDisplay({ price, decimals, flicker }) {
  const color = flicker === "up" ? "#00FF41" : flicker === "down" ? C.red : "#d0d0d0";
  const glow  = flicker === "up"
    ? "0 0 10px rgba(0,255,65,0.7)"
    : flicker === "down"
    ? "0 0 10px rgba(255,58,58,0.7)"
    : "none";

  return (
    <motion.span
      animate={{ color, textShadow: glow }}
      transition={{ duration: 0.08 }}
      style={{ fontSize: "0.9rem", fontWeight: 600, fontFamily: FONT_MONO, textAlign: "right" }}
    >
      {price !== undefined && price > 0
        ? price.toFixed(decimals)
        : "—"}
    </motion.span>
  );
}

// ── ConfidenceBadge ───────────────────────────────────────────────────────────
function ConfidenceBadge({ confidence, accent }) {
  const isFull = confidence === 100;
  const color  = isFull ? accent : confidence >= 67 ? C.amber : C.red;

  return (
    <motion.span
      animate={isFull
        ? { boxShadow: [`0 0 5px ${accent}40`, `0 0 12px ${accent}a6`, `0 0 5px ${accent}40`] }
        : {}}
      transition={{ duration: 1.6, repeat: Infinity }}
      style={{
        padding: "2px 7px", borderRadius: 6, fontSize: "0.6rem",
        fontWeight: 700, letterSpacing: "0.08em",
        background: `${color}18`,
        border:     `1px solid ${color}40`,
        color, fontFamily: FONT_MONO,
      }}
    >
      {confidence}%
    </motion.span>
  );
}