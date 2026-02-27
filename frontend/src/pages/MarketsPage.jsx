import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useWebSocket } from "../hooks/useWebSocket";
import { useAuthStore } from "../store/authStore";
import SparklineChart from "../components/charts/SparklineChart";
import AssetDetailDrawer from "../components/markets/AssetDetailDrawer";
import api from "../utils/api";

// ── Complete 20-instrument metadata map ────────────────────────────────────────
const INSTRUMENT_META = {
  // Forex Majors
  EUR_USD:    { label: "EUR/USD",   flag: "🇪🇺/🇺🇸", category: "Forex",   decimals: 5, pip: 0.0001 },
  USD_JPY:    { label: "USD/JPY",   flag: "🇺🇸/🇯🇵", category: "Forex",   decimals: 3, pip: 0.01   },
  GBP_USD:    { label: "GBP/USD",   flag: "🇬🇧/🇺🇸", category: "Forex",   decimals: 5, pip: 0.0001 },
  AUD_USD:    { label: "AUD/USD",   flag: "🇦🇺/🇺🇸", category: "Forex",   decimals: 5, pip: 0.0001 },
  USD_CAD:    { label: "USD/CAD",   flag: "🇺🇸/🇨🇦", category: "Forex",   decimals: 5, pip: 0.0001 },
  USD_CHF:    { label: "USD/CHF",   flag: "🇺🇸/🇨🇭", category: "Forex",   decimals: 5, pip: 0.0001 },
  GBP_JPY:    { label: "GBP/JPY",   flag: "🇬🇧/🇯🇵", category: "Forex",   decimals: 3, pip: 0.01   },
  EUR_GBP:    { label: "EUR/GBP",   flag: "🇪🇺/🇬🇧", category: "Forex",   decimals: 5, pip: 0.0001 },
  NZD_USD:    { label: "NZD/USD",   flag: "🇳🇿/🇺🇸", category: "Forex",   decimals: 5, pip: 0.0001 },
  AUD_JPY:    { label: "AUD/JPY",   flag: "🇦🇺/🇯🇵", category: "Forex",   decimals: 3, pip: 0.01   },
  // Metals
  XAU_USD:    { label: "XAU/USD",   flag: "🥇",       category: "Metals",  decimals: 2, pip: 0.01   },
  XAG_USD:    { label: "XAG/USD",   flag: "🥈",       category: "Metals",  decimals: 3, pip: 0.001  },
  XCU_USD:    { label: "XCU/USD",   flag: "🟤",       category: "Metals",  decimals: 4, pip: 0.0001 },
  // Indices
  SPX500_USD: { label: "S&P 500",   flag: "📈",       category: "Indices", decimals: 1, pip: 0.1    },
  NAS100_USD: { label: "Nasdaq",    flag: "💻",       category: "Indices", decimals: 1, pip: 0.1    },
  US30_USD:   { label: "Dow Jones", flag: "🏛️",       category: "Indices", decimals: 1, pip: 0.1    },
  DE30_EUR:   { label: "DAX",       flag: "🇩🇪",       category: "Indices", decimals: 1, pip: 0.1    },
  UK100_GBP:  { label: "FTSE 100",  flag: "🇬🇧",       category: "Indices", decimals: 1, pip: 0.1    },
  JP225_USD:  { label: "Nikkei",    flag: "🇯🇵",       category: "Indices", decimals: 1, pip: 0.1    },
  HK33_HKD:   { label: "Hang Seng", flag: "🇭🇰",       category: "Indices", decimals: 1, pip: 0.1    },
};

const CATEGORIES = ["All", "Forex", "Metals", "Indices"];

// ── Row heights for virtual scroll ─────────────────────────────────────────────
const ROW_HEIGHT = 80; // px — matches the rendered card height

export default function MarketsPage() {
  const { token }                       = useAuthStore();
  const [prices, setPrices]             = useState({});
  const [flickerState, setFlicker]      = useState({});
  const [analysis, setAnalysis]         = useState({});
  const [selectedAsset, setSelected]    = useState(null);
  const [filter, setFilter]             = useState("All");
  const [search, setSearch]             = useState("");
  const [sortBy, setSortBy]             = useState("default"); // "default" | "confidence" | "az"
  const flickerTimers                   = useRef({});
  const prevPrices                      = useRef({});

  const { lastMessage, send: sendWs } = useWebSocket(token);

  // ── Live tick handler ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!lastMessage) return;

    if (lastMessage.type === "TICK") {
      const { instrument, mid } = lastMessage;
      const prev = prevPrices.current[instrument];

      setPrices((p) => ({ ...p, [instrument]: mid }));
      prevPrices.current[instrument] = mid;

      if (prev !== undefined && mid !== prev) {
        const dir = mid > prev ? "up" : "down";
        setFlicker((f) => ({ ...f, [instrument]: dir }));
        clearTimeout(flickerTimers.current[instrument]);
        flickerTimers.current[instrument] = setTimeout(
          () => setFlicker((f) => ({ ...f, [instrument]: null })),
          420
        );
      }
    }

    if (lastMessage.type === "SNAPSHOT") {
      setPrices(lastMessage.prices || {});
      prevPrices.current = { ...(lastMessage.prices || {}) };
    }
  }, [lastMessage]);

  // ── Analysis polling (30 s) ──────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        const instruments = Object.keys(INSTRUMENT_META);
        // Fetch all 20 in parallel — the backend handles this fine
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
      } catch (e) {
        console.warn("Analysis fetch error:", e);
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  // ── Filtered + sorted instrument list ───────────────────────────────────────
  const visibleInstruments = Object.entries(INSTRUMENT_META).filter(([key, meta]) => {
    const catMatch    = filter === "All" || meta.category === filter;
    const searchMatch = meta.label.toLowerCase().includes(search.toLowerCase()) ||
                        key.toLowerCase().includes(search.toLowerCase());
    return catMatch && searchMatch;
  }).sort(([aKey, aMeta], [bKey, bMeta]) => {
    if (sortBy === "confidence") {
      return (analysis[bKey]?.confidence ?? 0) - (analysis[aKey]?.confidence ?? 0);
    }
    if (sortBy === "az") return aMeta.label.localeCompare(bMeta.label);
    return 0; // default — preserve original order
  });

  const liveCount = Object.keys(prices).length;

  return (
    <div className="flex flex-col h-full" style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* ── Sticky header ──────────────────────────────────────────────────── */}
      <div
        className="flex-shrink-0 px-4 pt-4 pb-2 z-30"
        style={{
          background:     "rgba(5,5,5,0.97)",
          backdropFilter: "blur(20px)",
          borderBottom:   "1px solid rgba(0,255,65,0.07)",
        }}
      >
        {/* Title row */}
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-xl font-display text-white tracking-wide">Markets</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <motion.div
                className="w-1.5 h-1.5 rounded-full bg-radiant-500"
                animate={{ opacity: [1, 0.2, 1] }}
                transition={{ duration: 1.4, repeat: Infinity }}
              />
              <span className="text-void-800 text-xs">
                {liveCount} / 20 live
              </span>
            </div>
          </div>

          {/* Sort toggle */}
          <div
            className="flex gap-1 p-1 rounded-xl"
            style={{ background: "#141414", border: "1px solid rgba(255,255,255,0.05)" }}
          >
            {[["default", "↕"], ["confidence", "%"], ["az", "A-Z"]].map(([val, label]) => (
              <button
                key={val}
                onClick={() => setSortBy(val)}
                className="px-2.5 py-1 rounded-lg text-[11px] font-display tracking-wider transition-all"
                style={{
                  background: sortBy === val ? "rgba(0,255,65,0.12)" : "transparent",
                  color:      sortBy === val ? "#00FF41" : "#444",
                  border:     sortBy === val ? "1px solid rgba(0,255,65,0.25)" : "1px solid transparent",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Search */}
        <div
          className="flex items-center gap-2 px-3 py-2.5 rounded-xl mb-2"
          style={{ background: "#141414", border: "1px solid rgba(255,255,255,0.05)" }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#444" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search instruments…"
            className="flex-1 bg-transparent text-sm text-white placeholder-void-600 outline-none"
          />
          {search && (
            <button onClick={() => setSearch("")} className="text-void-600 text-xs">✕</button>
          )}
        </div>

        {/* Category filter pills */}
        <div className="flex gap-1.5 overflow-x-auto scrollbar-none pb-1">
          {CATEGORIES.map((cat) => {
            const count = Object.values(INSTRUMENT_META).filter(
              (m) => cat === "All" || m.category === cat
            ).length;
            return (
              <motion.button
                key={cat}
                whileTap={{ scale: 0.94 }}
                onClick={() => setFilter(cat)}
                className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-display tracking-wide uppercase transition-all"
                style={{
                  background: filter === cat ? "rgba(0,255,65,0.1)" : "transparent",
                  border:     `1px solid ${filter === cat ? "rgba(0,255,65,0.3)" : "rgba(255,255,255,0.06)"}`,
                  color:      filter === cat ? "#00FF41" : "#4d4d4d",
                  boxShadow:  filter === cat ? "0 0 10px rgba(0,255,65,0.08)" : "none",
                }}
              >
                {cat}
                <span
                  className="px-1.5 py-0.5 rounded-full text-[10px]"
                  style={{
                    background: filter === cat ? "rgba(0,255,65,0.15)" : "rgba(255,255,255,0.05)",
                    color:      filter === cat ? "#00FF41" : "#333",
                  }}
                >
                  {count}
                </span>
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* ── Scrollable list ─────────────────────────────────────────────────── */}
      <div
        className="flex-1 overflow-y-auto overscroll-contain"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {/* Results count */}
        {search && (
          <div className="px-4 pt-3 pb-1">
            <span className="text-void-700 text-xs font-display tracking-wide">
              {visibleInstruments.length} result{visibleInstruments.length !== 1 ? "s" : ""}
            </span>
          </div>
        )}

        <div className="px-4 py-2 space-y-2 pb-6">
          {visibleInstruments.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <span className="text-3xl">🔍</span>
              <p className="text-void-700 text-sm font-display tracking-wide">No instruments found</p>
              <button
                onClick={() => { setSearch(""); setFilter("All"); }}
                className="text-radiant-500 text-xs underline underline-offset-2"
              >
                Clear filters
              </button>
            </div>
          )}

          {visibleInstruments.map(([instrument, meta], index) => {
            const price      = prices[instrument];
            const flicker    = flickerState[instrument];
            const analState  = analysis[instrument];
            const confidence = analState?.confidence ?? 0;
            const bias       = analState?.layer1?.bias ?? "NEUTRAL";
            const isFull     = confidence === 100;

            return (
              <motion.div
                key={instrument}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  delay: Math.min(index * 0.03, 0.4), // cap stagger at 0.4s for 20 items
                  duration: 0.25,
                  ease: [0.32, 0.72, 0, 1],
                }}
                whileTap={{ scale: 0.985 }}
                onClick={() => setSelected(instrument)}
                className="relative overflow-hidden rounded-2xl cursor-pointer"
                style={{
                  background:  "#0f0f0f",
                  border:      `1px solid ${isFull ? "rgba(0,255,65,0.22)" : "rgba(255,255,255,0.04)"}`,
                  boxShadow:   isFull ? "0 0 18px rgba(0,255,65,0.06)" : "none",
                  minHeight:   `${ROW_HEIGHT}px`,
                }}
              >
                {/* 100%-confluence top accent bar */}
                {isFull && (
                  <div
                    className="absolute top-0 left-0 right-0 h-[2px]"
                    style={{
                      background: "linear-gradient(90deg, transparent 0%, #00FF41 50%, transparent 100%)",
                      boxShadow:  "0 0 6px rgba(0,255,65,0.7)",
                    }}
                  />
                )}

                <div className="flex items-center gap-3 px-4 py-3">
                  {/* Flag / icon */}
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center text-base flex-shrink-0"
                    style={{
                      background: "rgba(255,255,255,0.03)",
                      border:     "1px solid rgba(255,255,255,0.06)",
                    }}
                  >
                    {meta.flag.split("/")[0]}
                  </div>

                  {/* Name + category + confidence */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-white text-[15px] font-display tracking-wide leading-none">
                        {meta.label}
                      </span>
                      {confidence > 0 && (
                        <ConfidencePill confidence={confidence} bias={bias} />
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-void-700 text-[11px]">{meta.category}</span>
                      {bias !== "NEUTRAL" && (
                        <span
                          className="text-[10px] font-display tracking-wider"
                          style={{ color: bias === "BULLISH" ? "#00FF41" : "#FF3A3A" }}
                        >
                          {bias === "BULLISH" ? "▲" : "▼"} {bias}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Sparkline + price */}
                  <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                    <PriceCell price={price} decimals={meta.decimals} flicker={flicker} />
                    <SparklineChart instrument={instrument} width={68} height={26} />
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>

        {/* Category section dividers when All is selected and no search */}
        {filter === "All" && !search && visibleInstruments.length === 20 && (
          <div className="px-4 pb-4">
            <p className="text-void-600 text-[10px] font-display tracking-widest uppercase text-center">
              20 instruments · Forex · Metals · Indices
            </p>
          </div>
        )}
      </div>

      {/* ── Asset detail drawer ──────────────────────────────────────────────── */}
      <AnimatePresence>
        {selectedAsset && (
          <AssetDetailDrawer
            instrument={selectedAsset}
            meta={INSTRUMENT_META[selectedAsset]}
            price={prices[selectedAsset]}
            analysis={analysis[selectedAsset]}
            onClose={() => setSelected(null)}
            sendWs={sendWs}
            wsMessage={lastMessage}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Price cell with flicker animation ─────────────────────────────────────────
function PriceCell({ price, decimals, flicker }) {
  const color = flicker === "up"
    ? "#00FF41"
    : flicker === "down"
    ? "#FF3A3A"
    : "#d0d0d0";

  const shadow = flicker === "up"
    ? "0 0 10px rgba(0,255,65,0.8)"
    : flicker === "down"
    ? "0 0 10px rgba(255,58,58,0.8)"
    : "none";

  return (
    <motion.span
      animate={{ color, textShadow: shadow }}
      transition={{ duration: 0.07 }}
      className="font-mono text-[13px] font-semibold tabular-nums"
      style={{ fontFamily: "'JetBrains Mono', monospace" }}
    >
      {price !== undefined ? price.toFixed(decimals) : "—"}
    </motion.span>
  );
}

// ── Confidence pill ───────────────────────────────────────────────────────────
function ConfidencePill({ confidence, bias }) {
  const isFull  = confidence === 100;
  const color   = isFull ? "#00FF41" : confidence >= 67 ? "#FFB800" : "#FF6B35";

  return (
    <motion.span
      animate={isFull ? {
        boxShadow: [
          "0 0 4px rgba(0,255,65,0.2)",
          "0 0 12px rgba(0,255,65,0.7)",
          "0 0 4px rgba(0,255,65,0.2)",
        ],
      } : {}}
      transition={{ duration: 1.8, repeat: Infinity }}
      className="px-1.5 py-0.5 rounded-md font-display text-[10px] tracking-wider"
      style={{
        background: `${color}15`,
        border:     `1px solid ${color}35`,
        color,
      }}
    >
      {confidence}%
    </motion.span>
  );
}