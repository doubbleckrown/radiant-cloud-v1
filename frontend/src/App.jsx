/**
 * App.jsx  —  FX Radiant root shell
 *
 * Layout (top → bottom, all layers):
 *   ① GlobalModeBar  — fixed, top-0, zIndex 60
 *       Left:   FX RADIANT brand dot + wordmark
 *       Center: ModeSwitcher segmented control (exact horizontal center)
 *       Right:  (empty — keeps center truly centered)
 *   ② Scanline overlay — absolute, inset 0, zIndex 50, pointer-events none
 *   ③ Dimension-Shift wrapper — AnimatePresence keyed on appMode
 *       Cross-dissolve + scale morph when FOREX ↔ CRYPTO switches
 *       Page scroll area lives inside this wrapper
 *   ④ Tab content — AnimatePresence keyed on activeTab (y-offset slide)
 *   ⑤ TabBar — fixed, bottom-0, zIndex 40
 *
 * Anti-flash strategy:
 *   • index.html inline script sets CSS custom properties synchronously
 *   • authStore._readMode() reads localStorage synchronously at module parse
 *   • Together these ensure the VERY FIRST React paint uses the correct mode
 */
import { useState, useEffect }         from "react";
import { AnimatePresence, motion }      from "framer-motion";
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

// ── Tab-switch animation (y-offset slide — unchanged) ────────────────────────
const pageVariants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.32, 0.72, 0, 1] } },
  exit:    { opacity: 0, y: -8, transition: { duration: 0.15 } },
};

// ── Mode-switch animation (cross-dissolve + scale morph) ─────────────────────
const modeVariants = {
  initial: { opacity: 0, scale: 0.98 },
  animate: {
    opacity: 1, scale: 1,
    transition: { duration: 0.32, ease: [0.32, 0.72, 0, 1] },
  },
  exit: {
    opacity: 0, scale: 1.02,
    transition: { duration: 0.22, ease: [0.32, 0.72, 0, 1] },
  },
};

const TABS = [
  { id: "markets", label: "Markets", icon: MarketIcon  },
  { id: "signals", label: "Signals", icon: SignalIcon  },
  { id: "account", label: "Account", icon: AccountIcon },
  { id: "profile", label: "Profile", icon: ProfileIcon },
];

// GlobalModeBar height constant
const BAR_H = 46;

// ═════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [activeTab, setActiveTab] = useState("markets");
  const {
    accent, accentHdr, accentDim, accentBdr, scanline, isCrypto, appMode,
  } = useTheme();

  useEffect(() => {
    initOneSignal().catch(() => {});
  }, []);

  const Page = {
    markets: MarketsPage,
    signals: SignalsPage,
    account: AccountPage,
    profile: ProfilePage,
  }[activeTab];

  const barOffset = `calc(${BAR_H}px + env(safe-area-inset-top, 0px))`;

  return (
    <>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>

      <SignedIn>
        {/*
          Root container — uses motion.div so background can cross-fade
          between modes.  Transition: 0.5s so it feels like the whole app
          "breathes" when switching.
        */}
        <motion.div
          animate={{ background: isCrypto ? "#060503" : "#050505" }}
          transition={{ duration: 0.5, ease: "easeInOut" }}
          style={{
            position:   "relative",
            width:      "100%",
            height:     "100vh",
            overflow:   "hidden",
            userSelect: "none",
            fontFamily: FONT_UI,
          }}
        >
          {/* ── ① Global Mode Bar ─────────────────────────────────────── */}
          <GlobalModeBar
            isCrypto={isCrypto}
            accent={accent}
            accentHdr={accentHdr}
            accentDim={accentDim}
            accentBdr={accentBdr}
            barH={BAR_H}
          />

          {/* ── ② Scanline overlay ───────────────────────────────────── */}
          <motion.div
            animate={{ backgroundImage: `repeating-linear-gradient(0deg, transparent, transparent 2px, ${scanline} 2px, ${scanline} 4px)` }}
            transition={{ duration: 0.4 }}
            style={{
              pointerEvents: "none",
              position:      "absolute",
              inset:         0,
              zIndex:        50,
              opacity:       0.022,
            }}
          />

          {/* ── ③ Dimension-Shift wrapper — keyed on appMode ─────────── */}
          {/*
            When appMode changes, AnimatePresence mode="wait" ensures the
            old content cross-fades OUT before the new content fades IN.
            This gives the "full-app morph" effect.
          */}
          <AnimatePresence mode="wait">
            <motion.div
              key={appMode}
              variants={modeVariants}
              initial="initial"
              animate="animate"
              exit="exit"
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
              {/* ── ④ Tab-switch animation — keyed on activeTab ───────── */}
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
            </motion.div>
          </AnimatePresence>

          {/* ── ⑤ TabBar ────────────────────────────────────────────── */}
          <TabBar tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} />
        </motion.div>
      </SignedIn>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  GlobalModeBar
//
//  Three-zone fixed header using absolute positioning so the ModeSwitcher
//  sits at the EXACT horizontal centre regardless of brand text width:
//    ┌───────────────────────────────────────────┐
//    │ ● FX RADIANT        [FX | ₿ CRYPTO]       │
//    └───────────────────────────────────────────┘
//    ↑ left: absolute        ↑ center: absolute translateX(-50%)
//
//  Handles iOS safe-area-inset-top internally via paddingTop.
// ─────────────────────────────────────────────────────────────────────────────
function GlobalModeBar({ isCrypto, accent, accentHdr, accentDim, accentBdr, barH }) {
  return (
    <div
      id="global-mode-bar"
      style={{
        position:             "fixed",
        top:                  0,
        left:                 0,
        right:                0,
        zIndex:               60,
        paddingTop:           "env(safe-area-inset-top, 0px)",
        height:               `calc(${barH}px + env(safe-area-inset-top, 0px))`,
        background:           "rgba(5,5,5,0.97)",
        backdropFilter:       "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
        borderBottom:         `1px solid ${accentHdr}`,
        boxSizing:            "border-box",
        // transition on border so the green→orange header border fades in
        transition:           "border-color 0.4s ease",
      }}
    >
      {/* ── Left: Brand ─────────────────────────────────────────────── */}
      <div style={{
        position:    "absolute",
        left:        16,
        bottom:      0,
        height:      barH,
        display:     "flex",
        alignItems:  "center",
        gap:         8,
      }}>
        <motion.div
          animate={{ opacity: [0.7, 1, 0.7] }}
          transition={{ duration: 2.4, repeat: Infinity }}
          style={{
            width:        7,
            height:       7,
            borderRadius: "50%",
            background:   accent,
            boxShadow:    `0 0 8px ${accent}`,
            transition:   "background 0.4s ease, box-shadow 0.4s ease",
          }}
        />
        <span style={{
          color:         accent,
          fontSize:      "0.72rem",
          fontWeight:    800,
          letterSpacing: "0.12em",
          fontFamily:    FONT_MONO,
          textShadow:    `0 0 10px ${accent}50`,
          transition:    "color 0.4s ease, text-shadow 0.4s ease",
        }}>
          FX RADIANT
        </span>
      </div>

      {/* ── Center: ModeSwitcher — exact horizontal centre ───────────── */}
      <div style={{
        position:   "absolute",
        left:       "50%",
        bottom:     0,
        transform:  "translateX(-50%)",
        height:     barH,
        display:    "flex",
        alignItems: "center",
      }}>
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
//  ModeSwitcher — Segmented Control
//
//  Design: 160 × 34px pill with a Framer Motion layoutId sliding highlight.
//  The layoutId="mode-pill" technique means Framer Motion animates the pill
//  from inside the FX button to inside the CRYPTO button (or vice versa)
//  as a smooth shared-layout transition — no manual x/left calculation needed.
//
//  Each segment is a full button that:
//    - Renders the layoutId pill ONLY when it is the active segment
//    - Calls toggleAppMode() when the INACTIVE segment is tapped
//      (tapping the active segment is a no-op)
// ─────────────────────────────────────────────────────────────────────────────
function ModeSwitcher({ isCrypto, accent, accentDim, accentBdr }) {
  const toggleAppMode = useAuthStore((s) => s.toggleAppMode);

  const FX_COLOR     = "#00FF41";
  const CRYPTO_COLOR = "#FFA500";

  const segBase = {
    position:       "relative",
    flex:           1,
    height:         "100%",
    border:         "none",
    background:     "transparent",
    cursor:         "pointer",
    display:        "flex",
    alignItems:     "center",
    justifyContent: "center",
    gap:            4,
    padding:        0,
    WebkitTapHighlightColor: "transparent",
  };

  return (
    <div
      style={{
        position:     "relative",
        width:        164,
        height:       34,
        borderRadius: 10,
        background:   "#0c0c0c",
        border:       `1px solid ${accentBdr}`,
        display:      "flex",
        padding:      3,
        gap:          2,
        boxShadow:    `0 0 20px ${accent}18`,
        transition:   "box-shadow 0.4s ease, border-color 0.4s ease",
      }}
    >
      {/* ── FX segment ──────────────────────────────────────────────── */}
      <button
        onClick={isCrypto ? toggleAppMode : undefined}
        aria-pressed={!isCrypto}
        aria-label="Switch to Forex mode"
        style={{ ...segBase, cursor: isCrypto ? "pointer" : "default" }}
      >
        {/* Sliding highlight — only present in the ACTIVE segment */}
        {!isCrypto && (
          <motion.div
            layoutId="mode-pill"
            style={{
              position:     "absolute",
              inset:        0,
              borderRadius: 7,
              background:   accentDim,
              border:       `1px solid ${accentBdr}`,
              boxShadow:    `0 0 12px ${accent}28`,
            }}
            transition={{ type: "spring", stiffness: 500, damping: 40 }}
          />
        )}
        <span style={{
          position:      "relative",
          zIndex:        1,
          fontSize:      "0.62rem",
          fontWeight:    700,
          fontFamily:    FONT_MONO,
          letterSpacing: "0.09em",
          color:         !isCrypto ? FX_COLOR : "#3a3a3a",
          textShadow:    !isCrypto ? `0 0 8px ${FX_COLOR}80` : "none",
          transition:    "color 0.25s, text-shadow 0.25s",
          pointerEvents: "none",
        }}>
          FX
        </span>
      </button>

      {/* ── CRYPTO segment ──────────────────────────────────────────── */}
      <button
        onClick={!isCrypto ? toggleAppMode : undefined}
        aria-pressed={isCrypto}
        aria-label="Switch to Crypto mode"
        style={{ ...segBase, cursor: !isCrypto ? "pointer" : "default" }}
      >
        {isCrypto && (
          <motion.div
            layoutId="mode-pill"
            style={{
              position:     "absolute",
              inset:        0,
              borderRadius: 7,
              background:   accentDim,
              border:       `1px solid ${accentBdr}`,
              boxShadow:    `0 0 12px ${accent}28`,
            }}
            transition={{ type: "spring", stiffness: 500, damping: 40 }}
          />
        )}
        <span style={{
          position:      "relative",
          zIndex:        1,
          fontSize:      "0.6rem",
          fontWeight:    700,
          fontFamily:    FONT_MONO,
          letterSpacing: "0.05em",
          color:         isCrypto ? CRYPTO_COLOR : "#3a3a3a",
          textShadow:    isCrypto ? `0 0 8px ${CRYPTO_COLOR}80` : "none",
          transition:    "color 0.25s, text-shadow 0.25s",
          pointerEvents: "none",
        }}>
          ₿ CRYPTO
        </span>
      </button>
    </div>
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