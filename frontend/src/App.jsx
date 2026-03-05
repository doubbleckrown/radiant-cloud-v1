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
import React, { useState, useEffect, useRef } from "react";
import { AnimatePresence, motion, useMotionValue, useTransform, animate } from "framer-motion";
import {
  SignedIn,
  SignedOut,
  RedirectToSignIn,
} from "@clerk/clerk-react";
import MarketsPage   from "./pages/MarketsPage";
import SignalsPage   from "./pages/SignalsPage";
import AccountPage   from "./pages/AccountPage";
import ProfilePage   from "./pages/ProfilePage";
import TabBar        from "./components/shared/TabBar";
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
// Dimension-Shift page wrapper variants
// Spec: Scale-Out (0.95) on exit, Scale-In (1.0) on enter
const modeVariants = {
  initial: { opacity: 0, scale: 0.95 },
  animate: {
    opacity: 1, scale: 1,
    transition: { duration: 0.32, ease: [0.32, 0.72, 0, 1] },
  },
  exit: {
    opacity: 0, scale: 0.95,
    transition: { duration: 0.25, ease: [0.32, 0.72, 0, 1] },
  },
};

// ── DimensionShiftOverlay variants ───────────────────────────────────────────
const overlayVariants = {
  initial: { opacity: 0 },
  enter:   { opacity: 1, transition: { duration: 0.25, ease: "easeOut" } },
  exit:    { opacity: 0, transition: { duration: 0.35, ease: "easeIn",  delay: 0.25 } },
};
const logoVariants = {
  initial: { scale: 0.82, opacity: 0 },
  enter:   { scale: 1,    opacity: 1, transition: { duration: 0.3,  ease: [0.32, 0.72, 0, 1] } },
  exit:    { scale: 1.06, opacity: 0, transition: { duration: 0.22, ease: "easeIn" } },
};

const TABS = [
  { id: "markets", label: "Markets", icon: MarketIcon  },
  { id: "signals", label: "Signals", icon: SignalIcon  },
  { id: "account", label: "Account", icon: AccountIcon },
  { id: "profile", label: "Profile", icon: ProfileIcon },
];

// GlobalModeBar height constant
const BAR_H = 46;

// ─────────────────────────────────────────────────────────────────────────────
//  Pull-to-Refresh
//
//  Touch listeners live on `window` — not on the scrollable div — so they
//  survive AnimatePresence remounts when appMode changes.  The scrollable div
//  ref is only used to read scrollTop (decides whether to engage the gesture).
//
//  Thresholds
//    THRESHOLD = 70 px → reload on release
//    MAX_PULL  = 110 px → rubber-band ceiling
//
//  Rubber-band: full speed below threshold, 30 % speed above it.
//  Release below threshold → spring back via framer-motion animate().
// ─────────────────────────────────────────────────────────────────────────────
const PTR_THRESHOLD = 70;
const PTR_MAX       = 110;

function usePullToRefresh(scrollRef) {
  const pullY = useMotionValue(0);

  useEffect(() => {
    let startY  = 0;
    let pulling = false;

    function onTouchStart(e) {
      // Only engage when the scrollable container is scrolled to the very top
      const el = scrollRef.current;
      if (el && el.scrollTop > 2) return;
      startY  = e.touches[0].clientY;
      pulling = false;
    }

    function onTouchMove(e) {
      const el    = scrollRef.current;
      const delta = e.touches[0].clientY - startY;

      // Bail if scrolled down or pulling upward
      if ((el && el.scrollTop > 2) || delta <= 0) {
        if (pulling) { pulling = false; pullY.set(0); }
        return;
      }

      pulling = true;

      // Rubber-band: full rate below threshold, 30 % above
      const dist = delta < PTR_THRESHOLD
        ? delta
        : PTR_THRESHOLD + (delta - PTR_THRESHOLD) * 0.3;

      pullY.set(Math.min(dist, PTR_MAX));

      // Block browser native pull-to-refresh / scroll bounce
      e.preventDefault();
    }

    function onTouchEnd() {
      if (!pulling) return;
      pulling = false;
      if (pullY.get() >= PTR_THRESHOLD) {
        // Brief pause so the user sees the indicator snap to "ready" state
        setTimeout(() => window.location.reload(true), 150);
      } else {
        animate(pullY, 0, { type: "spring", stiffness: 320, damping: 28 });
      }
    }

    // Listeners on window survive AnimatePresence remounts of child divs
    window.addEventListener("touchstart",  onTouchStart, { passive: true  });
    window.addEventListener("touchmove",   onTouchMove,  { passive: false }); // passive:false → can preventDefault
    window.addEventListener("touchend",    onTouchEnd,   { passive: true  });
    window.addEventListener("touchcancel", onTouchEnd,   { passive: true  });

    return () => {
      window.removeEventListener("touchstart",  onTouchStart);
      window.removeEventListener("touchmove",   onTouchMove);
      window.removeEventListener("touchend",    onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — window is stable

  return pullY;
}

// ── Pull indicator — pill that peeks out below the GlobalModeBar ──────────────
function PullIndicator({ pullY, accent }) {
  // Fade in only in the second half of the pull so it doesn't flash on scroll
  const opacity  = useTransform(pullY, [0, PTR_THRESHOLD * 0.5, PTR_THRESHOLD], [0, 0, 1]);
  // Slides down from behind the header as the user pulls
  const y        = useTransform(pullY, [0, PTR_THRESHOLD], [-20, 6]);
  // Chevron rotates 180° at threshold (↓ becomes ↑ / "ready" signal)
  const rotate   = useTransform(pullY, [PTR_THRESHOLD * 0.55, PTR_THRESHOLD], [0, 180]);
  const scale    = useTransform(pullY, [0, PTR_THRESHOLD], [0.7, 1]);

  return (
    <motion.div
      style={{
        position:       "absolute",
        top:            `calc(${BAR_H}px + env(safe-area-inset-top, 0px) + 4px)`,
        left:           "50%",
        x:              "-50%",   // framer-motion transform — no layout shift
        opacity,
        y,
        scale,
        zIndex:         58,       // above scanline (50), below GlobalModeBar (60)
        pointerEvents:  "none",
        display:        "flex",
        alignItems:     "center",
        justifyContent: "center",
        width:          36,
        height:         36,
        borderRadius:   "50%",
        background:     "rgba(10,10,10,0.85)",
        border:         "1px solid rgba(255,255,255,0.10)",
        backdropFilter: "blur(12px)",
        boxShadow:      `0 0 12px ${accent}30`,
      }}
    >
      <motion.svg
        style={{ rotate }}
        width="15" height="15" viewBox="0 0 24 24"
        fill="none" stroke={accent} strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round"
      >
        {/* Chevron down — rotates to chevron up at threshold */}
        <polyline points="6 9 12 15 18 9" />
      </motion.svg>
    </motion.div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [activeTab,  setActiveTab]  = useState("markets");
  const [shifting,   setShifting]   = useState(false);
  const [shiftMode,  setShiftMode]  = useState(null);
  const prevMode  = React.useRef(null);
  const scrollRef = useRef(null);   // points at the scrollable content div
  const pullY     = usePullToRefresh(scrollRef);
  const {
    accent, accentHdr, accentDim, accentBdr, scanline, isCrypto, appMode,
  } = useTheme();

  useEffect(() => {
    initOneSignal().catch(() => {});
  }, []);

  // ── Cinematic Dimension Shift: show overlay when mode changes ─────────────
  useEffect(() => {
    if (prevMode.current === null) {
      prevMode.current = isCrypto;
      return;
    }
    if (prevMode.current === isCrypto) return;
    prevMode.current = isCrypto;
    setShiftMode(isCrypto ? "CRYPTO" : "FOREX");
    setShifting(true);
    const t = setTimeout(() => setShifting(false), 1200);
    return () => clearTimeout(t);
  }, [isCrypto]);

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
          {/* ── Pull-to-Refresh indicator ─────────────────────────────── */}
          {/* Peeks out below the GlobalModeBar as the user drags down.    */}
          {/* Driven by pullY MotionValue — zero React re-renders.         */}
          <PullIndicator pullY={pullY} accent={accent} />

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
              ref={scrollRef}
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

        {/* ── Dimension Shift Overlay ────────────────────────────────── */}
        <AnimatePresence>
          {shifting && (
            <motion.div
              key="dim-shift-overlay"
              variants={overlayVariants}
              initial="initial"
              animate="enter"
              exit="exit"
              style={{
                position:"fixed",inset:0,zIndex:200,
                display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",
                background: shiftMode==="CRYPTO" ? "rgba(6,5,3,0.97)" : "rgba(5,5,5,0.97)",
                backdropFilter:"blur(24px)",WebkitBackdropFilter:"blur(24px)",
                pointerEvents:"none",
              }}
            >
              <motion.div variants={logoVariants} initial="initial" animate="enter" exit="exit">
                <DimensionLogo mode={shiftMode} />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </SignedIn>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  DimensionLogo — shown full-screen during mode transition
// ─────────────────────────────────────────────────────────────────────────────
function DimensionLogo({ mode }) {
  const isCr  = mode === "CRYPTO";
  const color = isCr ? "#FFA500" : "#00FF41";
  const label = isCr ? "BYBIT" : "OANDA";
  const sub   = isCr ? "Perpetuals · 20× Leverage" : "Forex · Metals · Indices";

  return (
    <div style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:20,userSelect:"none" }}>
      <motion.div
        animate={{ scale:[1,1.08,1], opacity:[0.8,1,0.8], boxShadow:[`0 0 40px ${color}50`,`0 0 80px ${color}80`,`0 0 40px ${color}50`] }}
        transition={{ duration:1.2,repeat:Infinity,ease:"easeInOut" }}
        style={{ width:72,height:72,borderRadius:"50%",background:`radial-gradient(circle,${color} 0%,${color}40 50%,transparent 75%)`,border:`2px solid ${color}60`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:"1.8rem",fontFamily:"'JetBrains Mono',monospace",color:"#000",fontWeight:900 }}
      >{isCr ? "₿" : "FX"}</motion.div>
      <div style={{ textAlign:"center" }}>
        <p style={{ color,fontSize:"1.6rem",fontWeight:900,letterSpacing:"0.18em",fontFamily:"'JetBrains Mono',monospace",margin:"0 0 6px",textShadow:`0 0 24px ${color}` }}>{label}</p>
        <p style={{ color:`${color}90`,fontSize:"0.65rem",letterSpacing:"0.14em",textTransform:"uppercase",fontFamily:"'Inter',sans-serif",margin:0 }}>{sub}</p>
      </div>
      <div style={{ display:"flex",gap:7 }}>
        {[0,1,2].map(i => (
          <motion.div key={i} animate={{ opacity:[0.2,1,0.2] }} transition={{ duration:0.8,delay:i*0.18,repeat:Infinity }}
            style={{ width:6,height:6,borderRadius:"50%",background:color }} />
        ))}
      </div>
    </div>
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