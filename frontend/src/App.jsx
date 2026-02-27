import { useState, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useAuthStore } from "./store/authStore";
import LoginPage from "./pages/LoginPage";
import MarketsPage from "./pages/MarketsPage";
import SignalsPage from "./pages/SignalsPage";
import AccountPage from "./pages/AccountPage";
import ProfilePage from "./pages/ProfilePage";
import TabBar from "./components/layout/TabBar";

const pageVariants = {
  initial:  { opacity: 0, y: 12 },
  animate:  { opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.32, 0.72, 0, 1] } },
  exit:     { opacity: 0, y: -8, transition: { duration: 0.15 } },
};

const TABS = [
  { id: "markets",  label: "Markets",  icon: MarketIcon  },
  { id: "signals",  label: "Signals",  icon: SignalIcon  },
  { id: "account",  label: "Account",  icon: AccountIcon },
  { id: "profile",  label: "Profile",  icon: ProfileIcon },
];

export default function App() {
  const { isAuthenticated } = useAuthStore();
  const [activeTab, setActiveTab] = useState("markets");

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  const Page = {
    markets: MarketsPage,
    signals: SignalsPage,
    account: AccountPage,
    profile: ProfilePage,
  }[activeTab];

  return (
    <div
      className="relative w-full h-screen bg-void overflow-hidden select-none"
      style={{ fontFamily: "'DM Sans', sans-serif" }}
    >
      {/* Scanline overlay — subtle OLED texture */}
      <div
        className="pointer-events-none absolute inset-0 z-50 opacity-[0.025]"
        style={{
          backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,65,0.08) 2px, rgba(0,255,65,0.08) 4px)",
        }}
      />

      {/* Status bar safe area */}
      <div className="h-safe-top bg-void" />

      {/* Main content area */}
      <div
        className="absolute inset-0 overflow-y-auto"
        style={{ paddingBottom: "calc(72px + env(safe-area-inset-bottom))" }}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            variants={pageVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="min-h-full"
          >
            <Page />
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Bottom Tab Bar */}
      <TabBar tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} />
    </div>
  );
}

// ── Tab Icons ────────────────────────────────────────────────────────────────

function MarketIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8}>
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
      <polyline points="16 7 22 7 22 13" />
    </svg>
  );
}

function SignalIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function AccountIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8}>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
    </svg>
  );
}

function ProfileIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8}>
      <circle cx="12" cy="7" r="4" />
      <path d="M5 21a7 7 0 0 1 14 0" />
    </svg>
  );
}