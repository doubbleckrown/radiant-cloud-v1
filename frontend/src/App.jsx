import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  SignedIn,
  SignedOut,
  RedirectToSignIn,
} from "@clerk/clerk-react";
import MarketsPage  from "./pages/MarketsPage";
import SignalsPage  from "./pages/SignalsPage";
import AccountPage  from "./pages/AccountPage";
import ProfilePage  from "./pages/ProfilePage";
import TabBar       from "./components/layout/TabBar";

// ── Page-switch animation ─────────────────────────────────────────────────────
const pageVariants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.32, 0.72, 0, 1] } },
  exit:    { opacity: 0, y: -8,  transition: { duration: 0.15 } },
};

const TABS = [
  { id: "markets", label: "Markets", icon: MarketIcon  },
  { id: "signals", label: "Signals", icon: SignalIcon  },
  { id: "account", label: "Account", icon: AccountIcon },
  { id: "profile", label: "Profile", icon: ProfileIcon },
];

// ═════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [activeTab, setActiveTab] = useState("markets");

  const Page = {
    markets: MarketsPage,
    signals: SignalsPage,
    account: AccountPage,
    profile: ProfilePage,
  }[activeTab];

  return (
    <>
      {/*
       * <SignedOut> — user has NO active Clerk session.
       * <RedirectToSignIn> tells Clerk to send them to the sign-in page.
       * Clerk reads afterSignOutUrl="/" from ClerkProvider, so after a
       * successful sign-in the user always lands back at the app root.
       *
       * Why RedirectToSignIn instead of a custom <AuthPage>:
       *   Using the Clerk-managed flow (hosted or <SignIn> component) is
       *   more reliable than a manual wrapper — it handles OAuth callbacks,
       *   magic-link redirects, and session resumption correctly.
       *   The Clerk <SignIn> component inside AuthPage is kept but we use
       *   RedirectToSignIn as the primary guard so the router always knows
       *   the intended destination.
       */}
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>

      {/* <SignedIn> — valid session confirmed by Clerk ── */}
      <SignedIn>
        <div
          style={{
            position:   "relative",
            width:      "100%",
            height:     "100vh",
            background: "#050505",
            overflow:   "hidden",
            userSelect: "none",
            fontFamily: "'Inter', sans-serif",
          }}
        >
          {/* Scanline overlay — subtle OLED depth */}
          <div
            style={{
              pointerEvents:   "none",
              position:        "absolute",
              inset:           0,
              zIndex:          50,
              opacity:         0.025,
              backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,65,0.08) 2px, rgba(0,255,65,0.08) 4px)",
            }}
          />

          {/* Status-bar safe area (iOS notch) */}
          <div style={{ height: "env(safe-area-inset-top, 0px)", background: "#050505" }} />

          {/* Scrollable page content — leaves room for the fixed TabBar */}
          <div
            style={{
              position:      "absolute",
              inset:         0,
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

          {/* Fixed bottom tab bar */}
          <TabBar tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} />
        </div>
      </SignedIn>
    </>
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