import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useWebSocket } from "../hooks/useWebSocket";
import SparklineChart from "../components/charts/SparklineChart";
import AssetDetailDrawer from "../components/markets/AssetDetailDrawer";
import api from "../utils/api";

const INSTRUMENT_META = {
  // ── Forex majors ────────────────────────────────────────────────────────────
  EUR_USD:    { label: "EUR/USD",  base: "EUR", quote: "USD", flag: "🇪🇺/🇺🇸", category: "Forex",   decimals: 5 },
  GBP_USD:    { label: "GBP/USD",  base: "GBP", quote: "USD", flag: "🇬🇧/🇺🇸", category: "Forex",   decimals: 5 },
  USD_JPY:    { label: "USD/JPY",  base: "USD", quote: "JPY", flag: "🇺🇸/🇯🇵", category: "Forex",   decimals: 3 },
  AUD_USD:    { label: "AUD/USD",  base: "AUD", quote: "USD", flag: "🇦🇺/🇺🇸", category: "Forex",   decimals: 5 },
  NZD_USD:    { label: "NZD/USD",  base: "NZD", quote: "USD", flag: "🇳🇿/🇺🇸", category: "Forex",   decimals: 5 },
  USD_CAD:    { label: "USD/CAD",  base: "USD", quote: "CAD", flag: "🇺🇸/🇨🇦", category: "Forex",   decimals: 5 },
  USD_CHF:    { label: "USD/CHF",  base: "USD", quote: "CHF", flag: "🇺🇸/🇨🇭", category: "Forex",   decimals: 5 },
  // ── Metals ──────────────────────────────────────────────────────────────────
  XAU_USD:    { label: "XAU/USD",  base: "XAU", quote: "USD", flag: "🥇/🇺🇸",  category: "Metals",  decimals: 2 },
  // ── Indices ─────────────────────────────────────────────────────────────────
  NAS100_USD: { label: "NAS100",   base: "NAS", quote: "USD", flag: "📈/🇺🇸", category: "Indices", decimals: 1 },
  US30_USD:   { label: "US30",     base: "US",  quote: "USD", flag: "🏛️/🇺🇸", category: "Indices", decimals: 1 },
  SPX500_USD: { label: "SPX500",   base: "SPX", quote: "USD", flag: "📊/🇺🇸", category: "Indices", decimals: 1 },
  GER30_EUR:  { label: "GER30",    base: "GER", quote: "EUR", flag: "🇩🇪/📊",  category: "Indices", decimals: 1 },
  UK100_GBP:  { label: "UK100",    base: "UK",  quote: "GBP", flag: "🇬🇧/📊",  category: "Indices", decimals: 1 },
  J225_USD:   { label: "J225",     base: "JP",  quote: "USD", flag: "🇯🇵/📊",  category: "Indices", decimals: 0 },
  // ── Crypto ──────────────────────────────────────────────────────────────────
  BTC_USD:    { label: "BTC/USD",  base: "BTC", quote: "USD", flag: "₿/🇺🇸",  category: "Crypto",  decimals: 1 },
};

const FILTER_CATEGORIES = ["All", "Forex", "Metals", "Indices", "Crypto"];

export default function MarketsPage() {
  const [prices, setPrices]       = useState({});
  const [prevPrices, setPrev]     = useState({});
  const [flickerState, setFlicker] = useState({});
  const [analysis, setAnalysis]   = useState({});
  const [selectedAsset, setSelected] = useState(null);
  const [filter, setFilter]       = useState("All");
  const [search, setSearch]       = useState("");
  const tickerRef = useRef({});

  // WebSocket for live ticks
  // WebSocket — Clerk token fetched internally
  const { lastMessage, send } = useWebSocket();

  // When the user selects an instrument, immediately request the latest price
  // from the backend rather than waiting for the next Oanda tick (which could
  // be several seconds away for less-liquid instruments).
  useEffect(() => {
    if (selectedAsset) {
      send({ type: "SUBSCRIBE", instrument: selectedAsset });
    }
  }, [selectedAsset, send]);

  useEffect(() => {
    if (!lastMessage) return;
    const msg = lastMessage;

    if (msg.type === "TICK") {
      const { instrument, mid } = msg;
      setPrev((prev) => ({ ...prev, [instrument]: prices[instrument] }));
      setPrices((prev) => {
        const prevPrice = prev[instrument];
        if (prevPrice !== undefined && mid !== prevPrice) {
          const dir = mid > prevPrice ? "up" : "down";
          setFlicker((f) => ({ ...f, [instrument]: dir }));
          // Clear flicker after animation
          clearTimeout(tickerRef.current[instrument]);
          tickerRef.current[instrument] = setTimeout(() => {
            setFlicker((f) => ({ ...f, [instrument]: null }));
          }, 450);
        }
        return { ...prev, [instrument]: mid };
      });
    }

    if (msg.type === "SNAPSHOT") {
      setPrices(msg.prices || {});
    }
  }, [lastMessage]);

  // Fetch analysis states periodically
  useEffect(() => {
    const fetchAnalysis = async () => {
      const instruments = Object.keys(INSTRUMENT_META);
      const results = await Promise.allSettled(
        instruments.map((ins) => api.get(`/markets/${ins}/analysis`))
      );
      const merged = {};
      instruments.forEach((ins, i) => {
        if (results[i].status === "fulfilled") {
          merged[ins] = results[i].value.data;
        }
      });
      setAnalysis(merged);
    };
    fetchAnalysis();
    const id = setInterval(fetchAnalysis, 30_000);
    return () => clearInterval(id);
  }, []);

  const filtered = Object.entries(INSTRUMENT_META).filter(([key, meta]) => {
    const categoryMatch = filter === "All" || meta.category === filter;
    const searchMatch   = meta.label.toLowerCase().includes(search.toLowerCase());
    return categoryMatch && searchMatch;
  });

  return (
    <div className="pb-4" style={{ fontFamily: "'DM Sans', sans-serif" }}>
      {/* Header */}
      <div
        className="sticky top-0 z-30 px-4 pt-4 pb-3"
        style={{
          background: "rgba(5,5,5,0.95)",
          backdropFilter: "blur(20px)",
          borderBottom: "1px solid rgba(0,255,65,0.06)",
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-xl font-display text-white tracking-wide">Markets</h1>
            <p style={{ color: "#aaaaaa", fontSize: "0.72rem", marginTop: 2 }}>
              {Object.keys(prices).length} live instruments
            </p>
          </div>
          {/* Live indicator */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full" style={{ background: "rgba(0,255,65,0.08)", border: "1px solid rgba(0,255,65,0.15)" }}>
            <motion.div
              className="w-1.5 h-1.5 rounded-full bg-radiant-500"
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ duration: 1.5, repeat: Infinity }}
            />
            <span className="text-radiant-500 text-xs font-display tracking-wider">LIVE</span>
          </div>
        </div>

        {/* Search bar */}
        <div
          className="flex items-center gap-2 px-3 py-2.5 rounded-xl mb-3"
          style={{ background: "#141414", border: "1px solid rgba(255,255,255,0.05)" }}
        >
          <SearchIcon />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search instruments..."
            className="flex-1 bg-transparent outline-none" style={{ fontSize: "0.875rem", color: "#ffffff" }}
          />
        </div>

        {/* Category filter pills */}
        <div className="flex gap-2 overflow-x-auto scrollbar-none pb-1">
          {FILTER_CATEGORIES.map((cat) => (
            <motion.button
              key={cat}
              whileTap={{ scale: 0.95 }}
              onClick={() => setFilter(cat)}
              className="flex-shrink-0 px-4 py-1.5 rounded-full text-xs font-display tracking-wide uppercase transition-all"
              style={{
                background: filter === cat ? "rgba(0,255,65,0.12)" : "transparent",
                border:     `1px solid ${filter === cat ? "rgba(0,255,65,0.35)" : "rgba(255,255,255,0.06)"}`,
                color:      filter === cat ? "#00FF41" : "#4d4d4d",
                boxShadow:  filter === cat ? "0 0 12px rgba(0,255,65,0.1)" : "none",
              }}
            >
              {cat}
            </motion.button>
          ))}
        </div>
      </div>

      {/* Market List */}
      <div className="px-4 py-2 space-y-2">
        {filtered.map(([instrument, meta], index) => {
          const price       = prices[instrument];
          const prev        = prevPrices[instrument];
          const flicker     = flickerState[instrument];
          const analState   = analysis[instrument];
          const confidence  = analState?.confidence ?? 0;
          const bias        = analState?.layer1?.bias ?? "NEUTRAL";

          return (
            <motion.div
              key={instrument}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05, duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
              whileTap={{ scale: 0.98 }}
              onClick={() => setSelected(instrument)}
              className="relative overflow-hidden rounded-2xl cursor-pointer"
              style={{
                background: "#0f0f0f",
                border: `1px solid ${confidence === 100 ? "rgba(0,255,65,0.25)" : "rgba(255,255,255,0.05)"}`,
                boxShadow: confidence === 100 ? "0 0 20px rgba(0,255,65,0.08)" : "none",
              }}
            >
              {/* 100% confidence glow strip */}
              {confidence === 100 && (
                <div
                  className="absolute top-0 left-0 right-0 h-[2px]"
                  style={{
                    background: "linear-gradient(90deg, transparent, #00FF41, transparent)",
                    boxShadow: "0 0 8px rgba(0,255,65,0.6)",
                  }}
                />
              )}

              <div className="flex items-center gap-3 p-4">
                {/* Flag / symbol */}
                <div
                  className="w-11 h-11 rounded-xl flex items-center justify-center text-lg flex-shrink-0"
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.06)",
                  }}
                >
                  {meta.flag.split("/")[0]}
                </div>

                {/* Name + SMC badge */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-white text-base font-display tracking-wide">
                      {meta.label}
                    </span>
                    {confidence > 0 && (
                      <ConfidenceBadge confidence={confidence} bias={bias} />
                    )}
                  </div>
                  <span style={{ color: "#aaaaaa", fontSize: "0.72rem" }}>{meta.category}</span>
                </div>

                {/* Sparkline + price */}
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  <PriceDisplay
                    price={price}
                    decimals={meta.decimals}
                    flicker={flicker}
                  />
                  <SparklineChart instrument={instrument} width={72} height={28} />
                </div>
              </div>

              {/* Hover/active shimmer */}
              <motion.div
                className="absolute inset-0 pointer-events-none"
                style={{ background: "radial-gradient(ellipse at center, rgba(0,255,65,0.03) 0%, transparent 70%)" }}
              />
            </motion.div>
          );
        })}
      </div>

      {/* Asset detail drawer */}
      <AnimatePresence>
        {selectedAsset && (
          <AssetDetailDrawer
            instrument={selectedAsset}
            meta={INSTRUMENT_META[selectedAsset]}
            price={prices[selectedAsset]}
            analysis={analysis[selectedAsset]}
            onClose={() => setSelected(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Price Display with flicker animation ──────────────────────────────────────

function PriceDisplay({ price, decimals, flicker }) {
  const color = flicker === "up" ? "#00FF41" : flicker === "down" ? "#FF3A3A" : "#e0e0e0";
  const glow  = flicker === "up"
    ? "0 0 10px rgba(0,255,65,0.7)"
    : flicker === "down"
    ? "0 0 10px rgba(255,58,58,0.7)"
    : "none";

  return (
    <motion.span
      animate={{ color, textShadow: glow }}
      transition={{ duration: 0.08 }}
      className="text-right font-mono text-sm font-semibold"
      style={{ fontFamily: "'JetBrains Mono', monospace" }}
    >
      {price !== undefined ? price.toFixed(decimals) : "—"}
    </motion.span>
  );
}

// ── Confidence Badge ──────────────────────────────────────────────────────────

function ConfidenceBadge({ confidence, bias }) {
  const isFull = confidence === 100;
  const color  = isFull ? "#00FF41" : confidence >= 67 ? "#FFB800" : "#FF3A3A";

  return (
    <motion.span
      animate={isFull ? { boxShadow: ["0 0 6px rgba(0,255,65,0.3)", "0 0 14px rgba(0,255,65,0.7)", "0 0 6px rgba(0,255,65,0.3)"] } : {}}
      transition={{ duration: 1.5, repeat: Infinity }}
      className="px-1.5 py-0.5 rounded-md text-[10px] font-display tracking-wider"
      style={{
        background: `${color}18`,
        border: `1px solid ${color}40`,
        color,
      }}
    >
      {confidence}%
    </motion.span>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#404040" strokeWidth="2">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  );
}