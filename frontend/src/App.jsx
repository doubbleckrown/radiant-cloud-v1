/**
 * App.jsx  —  FX Radiant root shell
 *
 * Layout (top → bottom, all layers):
 *   ① GlobalModeBar  — fixed, top-0, zIndex 60
 *       Contains the ModeSwitcher pill + app brand
 *   ② Scanline overlay — absolute, inset 0, zIndex 50, pointer-events none
 *   ③ Page scroll area — absolute, starts at GlobalModeBar bottom, overflowY auto
 *       Each page owns its own sticky sub-header (zIndex 20)
 *   ④ TabBar — fixed, bottom-0, zIndex 40
 *
 * The GlobalModeBar handles the iOS safe-area-inset-top internally so the
 * old status-bar spacer div is no longer needed.
 */
import { useState, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  SignedIn,
  SignedOut,
  RedirectToSignIn,
} from "@clerk/clerk-react";
import MarketsPage   from "./pages/MarketsPage";
import SignalsPage   from "./pages/SignalsPage";
import AccountPage   from "./pages/AccountPage";
import ProfilePage   from "./pages/ProfilePage";
import TabBar        from "./components/layout/TabBar";
import { useAuthStore } from "./store/authStore";
import { useTheme }     from "./hooks/useTheme";
import { initOneSignal } from "./services/pushNotifications";

const FONT_UI   = "'Inter', sans-serif";
const FONT_MONO = "'JetBrains Mono', monospace";

// ── Page-switch animation ─────────────────────────────────────────────────────
const pageVariants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.32, 0.72, 0, 1] } },
  exit:    { opacity: 0, y: -8, transition: { duration: 0.15 } },
};

const TABS = [
  { id: "markets", label: "Markets", icon: MarketIcon  },
  { id: "signals", label: "Signals", icon: SignalIcon  },
  { id: "account", label: "Account", icon: AccountIcon },
  { id: "profile", label: "Profile", icon: ProfileIcon },
];

// GlobalModeBar height constant (used in two places: the bar and the offset)
const BAR_H = 46;   // px, below the safe-area

// ═════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [activeTab, setActiveTab] = useState("markets");
  const { accent, accentHdr, accentDim, accentBdr, scanline, isCrypto } = useTheme();

  useEffect(() => {
    initOneSignal().catch(() => {});
  }, []);

  const Page = {
    markets: MarketsPage,
    signals: SignalsPage,
    account: AccountPage,
    profile: ProfilePage,
  }[activeTab];

  // Dynamic scroll container top offset
  const barOffset = `calc(${BAR_H}px + env(safe-area-inset-top, 0px))`;

  return (
    <>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>

      <SignedIn>
        <div
          style={{
            position:   "relative",
            width:      "100%",
            height:     "100vh",
            background: "#050505",
            overflow:   "hidden",
            userSelect: "none",
            fontFamily: FONT_UI,
          }}
        >
          {/* ── ① Global Mode Bar ─────────────────────────────────────────── */}
          <GlobalModeBar
            isCrypto={isCrypto}
            accent={accent}
            accentHdr={accentHdr}
            accentDim={accentDim}
            accentBdr={accentBdr}
            barH={BAR_H}
          />

          {/* ── ② Scanline overlay ───────────────────────────────────────── */}
          <div
            style={{
              pointerEvents:   "none",
              position:        "absolute",
              inset:           0,
              zIndex:          50,
              opacity:         0.022,
              backgroundImage: `repeating-linear-gradient(0deg, transparent, transparent 2px, ${scanline} 2px, ${scanline} 4px)`,
            }}
          />

          {/* ── ③ Page scroll area — starts below GlobalModeBar ─────────── */}
          <div
            style={{
              position:      "absolute",
              top:           barOffset,
              left:          0,
              right:         0,
              bottom:        0,
              overflowY:     "auto",
              paddingBottom: "calc(72px + env(safe-area-inset-bottom, 0px))",
            }}
          >
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                style={{ minHeight: "100%" }}
              >
                <Page />
              </motion.div>
            </AnimatePresence>
          </div>

          {/* ── ④ TabBar ───────────────────────────────────────────────── */}
          <TabBar tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} />
        </div>
      </SignedIn>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  GlobalModeBar
//  Fixed top bar containing the FX Radiant brand + ModeSwitcher pill.
//  Handles iOS safe-area-inset-top internally via paddingTop.
// ─────────────────────────────────────────────────────────────────────────────
function GlobalModeBar({ isCrypto, accent, accentHdr, accentDim, accentBdr, barH }) {
  return (
    <div
      style={{
        position:        "fixed",
        top:             0,
        left:            0,
        right:           0,
        zIndex:          60,
        paddingTop:      "env(safe-area-inset-top, 0px)",
        height:          `calc(${barH}px + env(safe-area-inset-top, 0px))`,
        background:      "rgba(5,5,5,0.97)",
        backdropFilter:  "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
        borderBottom:    `1px solid ${accentHdr}`,
        display:         "flex",
        alignItems:      "flex-end",
        justifyContent:  "space-between",
        padding:         `env(safe-area-inset-top, 0px) 16px 0`,
        boxSizing:       "border-box",
      }}
    >
      {/* Brand */}
      <div style={{ height: barH, display: "flex", alignItems: "center", gap: 8 }}>
        <motion.div
          animate={{ opacity: [0.7, 1, 0.7] }}
          transition={{ duration: 2.4, repeat: Infinity }}
          style={{
            width: 7, height: 7, borderRadius: "50%",
            background: accent,
            boxShadow: `0 0 8px ${accent}`,
          }}
        />
        <span style={{
          color:         accent,
          fontSize:      "0.72rem",
          fontWeight:    800,
          letterSpacing: "0.12em",
          fontFamily:    FONT_MONO,
          textShadow:    `0 0 10px ${accent}50`,
        }}>
          FX RADIANT
        </span>
      </div>

      {/* Mode Switcher */}
      <div style={{ height: barH, display: "flex", alignItems: "center" }}>
        <ModeSwitcher
          isCrypto={isCrypto}
          accent={accent}
          accentDim={accentDim}
          accentBdr={accentBdr}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  ModeSwitcher — pill toggle between FOREX (green) and CRYPTO (orange)
//
//  Design: 84px × 28px pill with animated sliding thumb, two labeled segments.
//  Tapping anywhere on the pill calls toggleAppMode().
// ─────────────────────────────────────────────────────────────────────────────
function ModeSwitcher({ isCrypto, accent, accentDim, accentBdr }) {
  const toggleAppMode = useAuthStore((s) => s.toggleAppMode);

  const FOREX_COLOR  = "#00FF41";
  const CRYPTO_COLOR = "#FFA500";

  return (
    <motion.button
      onClick={toggleAppMode}
      whileTap={{ scale: 0.95 }}
      aria-label={isCrypto ? "Switch to Forex mode" : "Switch to Crypto mode"}
      style={{
        position:   "relative",
        width:       88,
        height:      28,
        borderRadius: 99,
        border:      `1px solid ${accentBdr}`,
        background:  "#0c0c0c",
        cursor:      "pointer",
        padding:     0,
        overflow:    "hidden",
        display:     "flex",
        alignItems:  "center",
        boxShadow:   `0 0 12px ${accent}22`,
        transition:  "box-shadow 0.3s",
      }}
    >
      {/* Animated sliding thumb */}
      <motion.div
        animate={{ x: isCrypto ? 43 : 2 }}
        transition={{ type: "spring", stiffness: 480, damping: 36 }}
        style={{
          position:    "absolute",
          width:        41,
          height:       22,
          borderRadius: 99,
          background:   accentDim,
          border:      `1px solid ${accentBdr}`,
          boxShadow:   `0 0 8px ${accent}30`,
        }}
      />

      {/* FX label */}
      <span style={{
        flex:          1,
        textAlign:     "center",
        zIndex:        1,
        fontSize:      "0.6rem",
        fontWeight:    700,
        fontFamily:    FONT_MONO,
        letterSpacing: "0.07em",
        color:         !isCrypto ? FOREX_COLOR : "#3a3a3a",
        textShadow:    !isCrypto ? `0 0 8px ${FOREX_COLOR}80` : "none",
        transition:    "color 0.2s",
        pointerEvents: "none",
      }}>
        FX
      </span>

      {/* ₿ label */}
      <span style={{
        flex:          1,
        textAlign:     "center",
        zIndex:        1,
        fontSize:      "0.68rem",
        fontWeight:    700,
        fontFamily:    FONT_MONO,
        letterSpacing: "0.02em",
        color:         isCrypto ? CRYPTO_COLOR : "#3a3a3a",
        textShadow:    isCrypto ? `0 0 8px ${CRYPTO_COLOR}80` : "none",
        transition:    "color 0.2s",
        pointerEvents: "none",
      }}>
        ₿
      </span>
    </motion.button>
  );
}

// ── Tab icons ─────────────────────────────────────────────────────────────────
function MarketIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={active ? 2.2 : 1.8}>
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
      <polyline points="16 7 22 7 22 13" />
    </svg>
  );
}
function SignalIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={active ? 2.2 : 1.8}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}
function AccountIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={active ? 2.2 : 1.8}>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
    </svg>
  );
}
function ProfileIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={active ? 2.2 : 1.8}>
      <circle cx="12" cy="7" r="4" />
      <path d="M5 21a7 7 0 0 1 14 0" />
    </svg>
  );
}