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
  green:   "#00FF41",
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
  const [prices,         setPrices]        = useState({});
  const [flickerState,   setFlickerState]  = useState({});
  const [analysis,       setAnalysis]      = useState({});
  const [oandaChange24,  setOandaChange24] = useState({});   // instrument → 24h % change
  const [oandaCategory,  setOandaCategory] = useState("All");

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

  // ── Signal levels (for TP/SL chart lines) ────────────────────────────────
  // Keyed by instrument/symbol → most recent signal object
  const [oandaSignals, setOandaSignals] = useState({});
  const [bybitSignals, setBybitSignals] = useState({});

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
      const [{ data }, sigRes] = await Promise.all([
        api.get("/markets",  { headers: { "X-App-Mode": "FOREX" } }),
        api.get("/signals",  { headers: { "X-App-Mode": "FOREX" } }).catch(() => ({ data: [] })),
      ]);
      const map       = {};
      const changeMap = {};
      for (const item of (data ?? [])) {
        map[item.instrument]      = item;
        if (item.change24h != null) changeMap[item.instrument] = item.change24h;
      }
      setAnalysis(map);
      setOandaChange24(changeMap);
      // Most-recent signal per instrument for TP/SL chart lines
      const sigMap = {};
      for (const sig of (sigRes.data ?? [])) {
        const ins = sig.instrument ?? "";
        if (ins && !sigMap[ins]) sigMap[ins] = sig;   // already sorted newest-first
      }
      setOandaSignals(sigMap);
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
      const [{ data }, sigRes] = await Promise.all([
        api.get("/bybit/market",  { headers: { "X-App-Mode": "CRYPTO" } }),
        api.get("/bybit/signals", { headers: { "X-App-Mode": "CRYPTO" } }).catch(() => ({ data: [] })),
      ]);
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
      // Most-recent signal per symbol for TP/SL chart lines
      const sigMap = {};
      for (const sig of (sigRes.data ?? [])) {
        const sym = sig.symbol ?? sig.instrument ?? "";
        if (sym && !sigMap[sym]) sigMap[sym] = sig;   // already sorted newest-first
      }
      setBybitSignals(sigMap);
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
    // Seed prevPricesRef from the already-loaded price map so the first tick
    // after a mode switch doesn't generate spurious flicker on every instrument.
    // Without this, every price is treated as "new vs undefined" → all flash on load.
    const existingPrices = isCrypto ? bybitPrices : prices;
    prevPricesRef.current = { ...existingPrices };
  }, [isCrypto]);   // intentionally omit bybitPrices/prices from deps — this is a one-shot seed

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
              {liveCount} live · {isCrypto ? "Bybit Linear · SMC/ICT v3" : "Oanda v20 · SMC/ICT v3"}
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
          // 24h % change — Bybit from ticker meta, Oanda computed server-side from H1 open
          const change24 = isCrypto
            ? (bybitMeta[instrument]?.change24h ?? null)
            : (oandaChange24[instrument] ?? null);
          const isSelected = selectedInstrument === instrument;

          // ── 100% Panic Glow — spec colours from design brief ────────────
          const isPanic    = conf >= 100;
          const isBull100  = isPanic && (bias === "LONG"  || bias === "BULLISH");
          const isBear100  = isPanic && (bias === "SHORT" || bias === "BEARISH");
          const panicGlow  = isBull100
            ? "drop-shadow(0 0 15px #4ADE80) drop-shadow(0 0 6px #4ADE8060)"
            : isBear100
            ? "drop-shadow(0 0 15px #F87171) drop-shadow(0 0 6px #F8717160)"
            : "none";
          // ── Price change border flash (feature parity: Oanda SSE + Bybit poll) ──
          // flicker "up"   → 600ms neon green border + soft glow
          // flicker "down" → 600ms neon red border + soft glow
          // panic 100%     → sustained pulse overrides flicker
          const flickerBorder = flicker === "up"
            ? "1px solid rgba(0,255,65,0.55)"
            : flicker === "down"
            ? "1px solid rgba(255,0,0,0.55)"
            : null;
          const flickerShadow = flicker === "up"
            ? "0 0 12px rgba(0,255,65,0.22)"
            : flicker === "down"
            ? "0 0 12px rgba(255,0,0,0.22)"
            : null;

          const panicBorder = isBull100
            ? "1px solid rgba(74,222,128,0.55)"
            : isBear100
            ? "1px solid rgba(248,113,113,0.55)"
            : null;

          const activeBorder = panicBorder
            ?? flickerBorder
            ?? (isSelected ? `1px solid ${accentBdr}` : "1px solid transparent");

          return (
            <motion.div
              key={instrument}
              layout
              onClick={() => setSelectedInstrument(isSelected ? null : instrument)}
              animate={{
                filter:    panicGlow,
                // Panic: sustained slow pulse. Flicker: fast single flash.
                boxShadow: isPanic
                  ? isBull100
                    ? ["0 0 0px transparent", "0 0 24px #4ADE8040", "0 0 0px transparent"]
                    : ["0 0 0px transparent", "0 0 24px #F8717140", "0 0 0px transparent"]
                  : flickerShadow ?? "0 0 0px transparent",
                // Border animates between flicker, panic, and neutral
                borderColor: isPanic
                  ? (isBull100 ? "rgba(74,222,128,0.55)" : "rgba(248,113,113,0.55)")
                  : flicker === "up"
                  ? "rgba(0,255,65,0.55)"
                  : flicker === "down"
                  ? "rgba(255,0,0,0.55)"
                  : isSelected
                  ? accentBdr
                  : "transparent",
              }}
              transition={isPanic
                ? { boxShadow: { duration: 1.8, repeat: Infinity, ease: "easeInOut" }, filter: { duration: 0.3 } }
                : { duration: 0.15 }
              }
              style={{
                borderRadius: 14,
                background:   isSelected ? accentDim : "transparent",
                border:       activeBorder,
                cursor:       "pointer",
                overflow:     "hidden",
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
                      signal={isCrypto ? bybitSignals[instrument] : oandaSignals[instrument]}
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
  const isBullish  = bias === "LONG"  || bias === "BULLISH";
  const isBearish  = bias === "SHORT" || bias === "BEARISH";
  const biasLabel  = isBullish ? "BULLISH" : isBearish ? "BEARISH" : "";

  // ── Layered Confluence Color Evolution — SMC/ICT v3 stages ─────────────────
  // Stage 1 (34%) : Grey       — Daily HTF bias confirmed (HH+HL or EMA alignment)
  // Stage 2 (67%) : Blue       — H1 Liquidity sweep detected (stop-hunt confirmed)
  // Stage 3+4 (100%): Green/Red — H1 MSS (CHoCH/BOS) + M5 OB or FVG entry zone
  const layerColor = conf >= 100
    ? (isBullish ? "#00FF00" : isBearish ? "#FF0000" : accent)
    : conf >= 67
    ? "#00BFFF"    // H1 Liquidity Sweep stage — cyan/blue
    : conf >= 34
    ? "#888888"
    : C.sub;

  const labelColor = layerColor;

  const glowColor = conf >= 100
    ? (isBullish ? "rgba(0,255,0,0.85)" : isBearish ? "rgba(255,0,0,0.85)" : null)
    : conf >= 67
    ? "rgba(0,191,255,0.6)"    // H1 sweep glow
    : null;

  // Stage sublabel — shown below the confidence number
  const stageLabel = conf >= 100
    ? "FULL CONF"
    : conf >= 67
    ? "LIQ SWEPT"
    : conf >= 34
    ? "D BIAS"
    : "";

  return (
    <span style={{
      display:       "inline-flex",
      flexDirection: "column",
      alignItems:    "center",
      gap:           1,
      fontSize:      "0.6rem",
      fontWeight:    700,
      padding:       "2px 7px",
      borderRadius:  5,
      background:    `${labelColor}12`,
      border:        `1px solid ${labelColor}30`,
      color:         labelColor,
      fontFamily:    FONT_MONO,
      letterSpacing: "0.06em",
      textShadow:    glowColor ? `0 0 10px ${glowColor}` : "none",
      filter:        conf >= 67 ? `drop-shadow(0 0 6px ${labelColor}99)` : "none",
      lineHeight:    1.2,
    }}>
      <span>{conf}% {biasLabel}</span>
      {stageLabel && (
        <span style={{ fontSize: "0.45rem", opacity: 0.7, letterSpacing: "0.1em" }}>
          {stageLabel}
        </span>
      )}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  InlineChart — candlestick + TP/SL/Entry price lines for Oanda and Bybit
// ─────────────────────────────────────────────────────────────────────────────
//  Price lines are drawn via series.createPriceLine() using lightweight-charts
//  native API. Three lines per signal:
//    ● Entry — white dashed   (where the bot entered)
//    ● TP    — green solid    (take-profit target)
//    ● SL    — red dashed     (stop-loss invalidation level)
//  Lines are added/removed whenever the `signal` prop changes.
//  LineStyle values: 0=Solid, 1=Dotted, 2=Dashed, 3=LargeDashed
// ─────────────────────────────────────────────────────────────────────────────
function InlineChart({ instrument, isCrypto, granularity, setGranularity, accent, meta, analysis, signal }) {
  const chartRef      = useRef(null);
  const chartInstance = useRef(null);
  const seriesRef     = useRef(null);
  // Keep refs to active price lines so we can remove them before re-drawing
  const priceLinesRef = useRef([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  const OANDA_GRAN  = ["M1", "M5", "M15", "H1"];
  const BYBIT_GRAN  = ["M1", "M5", "M15", "H1"];
  const grans       = isCrypto ? BYBIT_GRAN : OANDA_GRAN;

  // ── Chart initialisation (once per mount) ─────────────────────────────────
  useEffect(() => {
    if (!chartRef.current) return;
    const chart = createChart(chartRef.current, {
      width:  chartRef.current.clientWidth,
      height: 240,
      layout:      { background: { color: "transparent" }, textColor: C.sub },
      grid:        { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      crosshair:   { mode: 1 },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.1)" },
      timeScale:       { borderColor: "rgba(255,255,255,0.1)", timeVisible: true, secondsVisible: false },
    });
    const series = chart.addCandlestickSeries({
      upColor:         accent,
      downColor:       C.red,
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

  // ── Candle data fetch (re-runs on instrument / granularity / mode change) ──
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

  // ── TP / SL / Entry price lines ───────────────────────────────────────────
  // Re-drawn every time the signal prop changes (new signal fired, or chart
  // opens for an instrument that already has one).
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    // Remove any previously drawn lines first
    for (const line of priceLinesRef.current) {
      try { series.removePriceLine(line); } catch { /* already gone */ }
    }
    priceLinesRef.current = [];

    if (!signal) return;

    const entry = parseFloat(signal.entry ?? signal.entry_price ?? 0);
    const sl    = parseFloat(signal.sl    ?? signal.stop_loss   ?? 0);
    const tp    = parseFloat(signal.tp    ?? signal.take_profit ?? 0);
    if (!entry || !sl || !tp) return;

    const isLong = signal.direction === "LONG";

    // Entry line — white dashed, subtle
    const entryLine = series.createPriceLine({
      price:      entry,
      color:      "rgba(255,255,255,0.55)",
      lineWidth:  1,
      lineStyle:  2,             // Dashed
      axisLabelVisible: true,
      title:      "ENTRY",
    });

    // TP line — green solid, labelled with RR
    const rr      = signal.rr ?? (Math.abs(tp - entry) / Math.abs(entry - sl)).toFixed(1);
    const tpLine  = series.createPriceLine({
      price:      tp,
      color:      "#00FF41",
      lineWidth:  1,
      lineStyle:  0,             // Solid
      axisLabelVisible: true,
      title:      `TP  1:${typeof rr === "number" ? rr.toFixed(1) : rr}`,
    });

    // SL line — red dashed
    const slLine  = series.createPriceLine({
      price:      sl,
      color:      "#FF3A3A",
      lineWidth:  1,
      lineStyle:  2,             // Dashed
      axisLabelVisible: true,
      title:      `SL  ${isLong ? "▼" : "▲"}`,
    });

    priceLinesRef.current = [entryLine, tpLine, slLine];
  }, [signal]); // eslint-disable-line

  // Signal metadata for the legend strip below the toolbar
  const hasSignal = Boolean(signal && signal.sl && signal.tp);
  const sigEntry  = parseFloat(signal?.entry ?? signal?.entry_price ?? 0);
  const sigSl     = parseFloat(signal?.sl    ?? signal?.stop_loss   ?? 0);
  const sigTp     = parseFloat(signal?.tp    ?? signal?.take_profit ?? 0);
  const sigDir    = signal?.direction ?? "";
  const sigRr     = signal?.rr ?? (sigEntry && sigSl ? (Math.abs(sigTp - sigEntry) / Math.abs(sigEntry - sigSl)).toFixed(1) : "—");
  const dp        = meta?.decimals ?? 5;

  return (
    <div style={{ padding: "0 12px 14px" }}>

      {/* ── Toolbar: granularity + SMC tags ─────────────────────────────── */}
      <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
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
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          {analysis?.layer2 && <MiniTag label="LIQ SWEPT" accent="#00BFFF" />}
          {analysis?.layer3 && <MiniTag label="MSS+ZONE" accent={accent} />}
          {hasSignal && (
            <MiniTag
              label={sigDir === "LONG" ? "▲ LONG" : "▼ SHORT"}
              accent={sigDir === "LONG" ? "#00FF41" : "#FF3A3A"}
            />
          )}
        </div>
      </div>

      {/* ── SMC/ICT v3 Pipeline Stage Strip ──────────────────────────────────
           Shows which of the 4 algorithm stages are currently confirmed.
           Inferred from analysis.confidence + analysis.layer2/layer3.
           Oanda bulk endpoint only sends confidence (no layer2/layer3 bools),
           so we infer from thresholds. Bybit sends explicit bool fields.    */}
      {analysis && (analysis.confidence > 0 || analysis.layer2 || analysis.layer3) && (
        <SMCPipelineStrip analysis={analysis} accent={accent} />
      )}

      {/* ── TP/SL legend strip — shown only when a signal is present ─────── */}
      {hasSignal && (
        <div style={{
          display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap",
        }}>
          {[
            { label: "ENTRY", val: sigEntry.toFixed(dp), color: "rgba(255,255,255,0.7)", bg: "rgba(255,255,255,0.05)", bd: "rgba(255,255,255,0.15)" },
            { label: "TP",    val: sigTp.toFixed(dp),    color: "#00FF41",               bg: "rgba(0,255,65,0.06)",    bd: "rgba(0,255,65,0.25)"    },
            { label: "SL",    val: sigSl.toFixed(dp),    color: "#FF3A3A",               bg: "rgba(255,58,58,0.06)",   bd: "rgba(255,58,58,0.25)"   },
            { label: "R:R",   val: `1 : ${sigRr}`,       color: accent,                  bg: `${accent}08`,            bd: `${accent}30`            },
          ].map(({ label, val, color, bg, bd }) => (
            <div key={label} style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "4px 10px", borderRadius: 8,
              background: bg, border: `1px solid ${bd}`,
            }}>
              <span style={{ color: "rgba(255,255,255,0.35)", fontSize: "0.55rem", fontFamily: FONT_UI, letterSpacing: "0.08em" }}>
                {label}
              </span>
              <span style={{ color, fontSize: "0.7rem", fontWeight: 700, fontFamily: FONT_MONO }}>
                {val}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── Chart canvas ─────────────────────────────────────────────────── */}
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

      {/* No-signal note — only shown when the chart is open but no signal yet */}
      {!hasSignal && !loading && (
        <p style={{ color: C.sub, fontSize: "0.6rem", textAlign: "center", margin: "8px 0 0", fontFamily: FONT_MONO }}>
          Awaiting full confluence — D Bias → H1 Sweep → MSS → M5 OB/FVG
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  SMCPipelineStrip — shows current algorithm stage depth for expanded chart
//
//  4 stages in the v3 pipeline:
//    Stage 1: Daily HTF Bias       (confidence ≥ 34 OR layer1_bias ≠ NEUTRAL)
//    Stage 2: H1 Liquidity Sweep   (confidence ≥ 67 OR analysis.layer2 === true)
//    Stage 3: H1 MSS (CHoCH/BOS)   (confidence ≥ 100 OR analysis.layer3 === true)
//    Stage 4: M5 OB / FVG Entry    (confidence = 100 — only fires with M5 data)
//
//  Oanda /markets bulk endpoint: provides only confidence + bias
//  Bybit  /bybit/market endpoint: provides confidence + layer2 (bool) + layer3 (bool)
// ─────────────────────────────────────────────────────────────────────────────
function SMCPipelineStrip({ analysis, accent }) {
  const conf = analysis?.confidence ?? 0;
  const bias = analysis?.bias ?? "NEUTRAL";

  // Stage flags — use explicit booleans when available (Bybit), else infer from conf
  const s1 = conf >= 34  || (bias !== "NEUTRAL" && bias != null);
  const s2 = analysis?.layer2 === true ? true : conf >= 67;
  const s3 = analysis?.layer3 === true ? true : conf >= 100;
  const s4 = conf >= 100;   // only reachable after full M5 confirmation

  const isBull = bias === "BULLISH" || bias === "LONG";
  const dirColor = s4 ? (isBull ? "#00FF00" : "#FF0000") : accent;

  const stages = [
    { key: "s1", label: "D Bias",    sublabel: "Daily HTF",  active: s1,  color: "#888888" },
    { key: "s2", label: "H1 Sweep",  sublabel: "Liq. Hunt",  active: s2,  color: "#00BFFF" },
    { key: "s3", label: "MSS",       sublabel: "CHoCH/BOS",  active: s3,  color: "#FFB800" },
    { key: "s4", label: "M5 Zone",   sublabel: "OB / FVG",   active: s4,  color: dirColor  },
  ];

  return (
    <div style={{
      display: "flex", gap: 4, marginBottom: 8, alignItems: "stretch",
    }}>
      {stages.map((st, i) => (
        <div key={st.key} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
          {/* Connector line between stages */}
          <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <div style={{
              flex: 1, height: 2, borderRadius: 1,
              background: st.active
                ? `linear-gradient(90deg, ${stages[i-1]?.active ? st.color : "transparent"} 0%, ${st.color} 100%)`
                : "rgba(255,255,255,0.07)",
              transition: "background 0.4s",
            }} />
            <div style={{
              width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
              background: st.active ? st.color : "rgba(255,255,255,0.1)",
              boxShadow: st.active ? `0 0 6px ${st.color}` : "none",
              transition: "background 0.4s, box-shadow 0.4s",
            }} />
          </div>
          {/* Stage label */}
          <div style={{ paddingLeft: 2 }}>
            <p style={{
              margin: 0, fontSize: "0.52rem", fontWeight: 700,
              fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.06em",
              color: st.active ? st.color : "rgba(255,255,255,0.15)",
              transition: "color 0.4s",
            }}>{st.label}</p>
            <p style={{
              margin: 0, fontSize: "0.45rem",
              fontFamily: "'Inter', sans-serif",
              color: st.active ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.1)",
              transition: "color 0.4s",
            }}>{st.sublabel}</p>
          </div>
        </div>
      ))}
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