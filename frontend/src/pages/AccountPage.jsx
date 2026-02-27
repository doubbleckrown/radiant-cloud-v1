/**
 * AccountPage
 * ══════════════════════════════════════════════════════════════════
 * Layout (top → bottom):
 *   1. Sticky header
 *   2. Master Auto-Trade toggle  ← always visible, works even if Oanda is down
 *   3. Account summary / error / spinner
 *   4. Stat grid (balance, NAV, P&L, etc.)
 *
 * The toggle is intentionally placed ABOVE the account-load section so the
 * user can always enable/disable auto-execution regardless of whether the
 * Oanda account fetch succeeds.
 *
 * Utilities from index.css:
 *   .border-glow-green  — neon green ring on the active toggle card
 *   .active-scale       — native-feel press animation on the toggle button
 */
import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import api from "../utils/api";
import { useAuthStore } from "../store/authStore";

export default function AccountPage() {
  const { user, fetchMe, updateAutoTrade } = useAuthStore();

  const [account,      setAccount]      = useState(null);
  const [accountError, setAccountError] = useState(null);
  const [loadingAcct,  setLoadingAcct]  = useState(true);

  // Toggle UI state — tracks an in-flight PATCH so we can show a spinner
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState(null);

  const autoTradeOn = user?.auto_trade_enabled ?? false;

  // ── On mount: hydrate auto_trade_enabled + fetch account ──────────────────
  useEffect(() => {
    fetchMe();        // ensures auto_trade_enabled is fresh from the server
    loadAccount();    // load Oanda account summary
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadAccount = useCallback(async () => {
    setLoadingAcct(true);
    setAccountError(null);
    try {
      const { data } = await api.get("/account");
      setAccount(data);
    } catch (err) {
      // Use the smart userMessage set by the api.js interceptor
      setAccountError(
        err.userMessage ?? "Could not load account data"
      );
    } finally {
      setLoadingAcct(false);
    }
  }, []);

  // ── Toggle handler ─────────────────────────────────────────────────────────
  const handleToggle = useCallback(async () => {
    if (toggling) return;          // debounce double-taps
    setToggling(true);
    setToggleError(null);
    try {
      await updateAutoTrade(!autoTradeOn);
    } catch (err) {
      setToggleError(
        err.userMessage ?? "Could not save setting — try again"
      );
    } finally {
      setToggling(false);
    }
  }, [toggling, autoTradeOn, updateAutoTrade]);

  // ── Derived stat cards (only when account loaded) ─────────────────────────
  const statCards = account ? [
    { label: "Balance",        value: `$${parseFloat(account.balance       ?? 0).toFixed(2)}` },
    { label: "NAV",            value: `$${parseFloat(account.NAV           ?? 0).toFixed(2)}` },
    { label: "Unrealised P&L", value: `$${parseFloat(account.unrealizedPL  ?? 0).toFixed(2)}`, colored: true },
    { label: "Open Trades",    value:   account.openTradeCount ?? 0 },
    { label: "Margin Used",    value: `$${parseFloat(account.marginUsed    ?? 0).toFixed(2)}` },
    { label: "Margin Avail.",  value: `$${parseFloat(account.marginAvailable ?? 0).toFixed(2)}` },
  ] : [];

  return (
    <div className="flex flex-col min-h-full" style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* ── Sticky header ──────────────────────────────────────────────────── */}
      <div
        className="sticky top-0 z-20 px-4 pt-4 pb-3"
        style={{
          background:    "rgba(5,5,5,0.97)",
          backdropFilter:"blur(20px)",
          borderBottom:  "1px solid rgba(0,255,65,0.06)",
        }}
      >
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-display text-white tracking-wide">Account</h1>
            <p className="text-void-800 text-xs mt-0.5">Oanda v20 · Live data</p>
          </div>
          {/* Live indicator */}
          <div
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full"
            style={{ background:"rgba(0,255,65,0.07)", border:"1px solid rgba(0,255,65,0.15)" }}
          >
            <motion.div
              className="w-1.5 h-1.5 rounded-full"
              style={{ background:"#00FF41" }}
              animate={{ opacity:[1, 0.25, 1] }}
              transition={{ duration:1.4, repeat:Infinity }}
            />
            <span className="text-[11px] font-display tracking-wider" style={{ color:"#00FF41" }}>LIVE</span>
          </div>
        </div>
      </div>

      <div className="px-4 py-4 flex flex-col gap-4">

        {/* ══════════════════════════════════════════════════════════════════
            MASTER AUTO-TRADE TOGGLE
            ── Sits above the account section so it always works, even when
               the Oanda account fetch fails or is loading.
        ══════════════════════════════════════════════════════════════════ */}
        <AutoTradeToggle
          isOn={autoTradeOn}
          toggling={toggling}
          error={toggleError}
          onToggle={handleToggle}
        />

        {/* ══════════════════════════════════════════════════════════════════
            ACCOUNT SUMMARY
        ══════════════════════════════════════════════════════════════════ */}

        {/* Loading spinner */}
        {loadingAcct && !account && (
          <div className="flex items-center justify-center py-16">
            <motion.div
              animate={{ rotate:360 }}
              transition={{ duration:1, repeat:Infinity, ease:"linear" }}
              className="w-8 h-8 rounded-full border-2 border-transparent"
              style={{ borderTopColor:"#00FF41" }}
            />
          </div>
        )}

        {/* Error state — uses the smart message from the api.js interceptor */}
        {accountError && !loadingAcct && (
          <div
            className="rounded-2xl p-4"
            style={{
              background:"rgba(255,58,58,0.06)",
              border:"1px solid rgba(255,58,58,0.15)",
            }}
          >
            <p className="text-bear text-sm font-display">Connection Error</p>
            <p className="text-void-800 text-xs mt-1 leading-relaxed">{accountError}</p>
            <button
              onClick={loadAccount}
              className="active-scale mt-3 px-4 py-2 rounded-xl text-xs font-display tracking-widest uppercase"
              style={{
                background:"rgba(255,255,255,0.06)",
                border:"1px solid rgba(255,255,255,0.1)",
                color:"#ccc",
              }}
            >
              Retry
            </button>
          </div>
        )}

        {/* Account data */}
        {account && (
          <>
            {/* Account ID banner */}
            <div
              className="p-4 rounded-2xl"
              style={{ background:"rgba(0,255,65,0.05)", border:"1px solid rgba(0,255,65,0.12)" }}
            >
              <div className="text-void-700 text-xs font-display uppercase tracking-wider mb-1">Account ID</div>
              <div
                className="font-mono text-radiant-500 text-sm"
                style={{ fontFamily:"'JetBrains Mono', monospace" }}
              >
                {account.id}
              </div>
              <div className="text-void-700 text-xs mt-1 capitalize">
                {account.type?.toLowerCase()} account
              </div>
            </div>

            {/* Stat grid */}
            <div className="grid grid-cols-2 gap-3">
              {statCards.map((stat, i) => {
                const pnl      = stat.colored ? parseFloat(stat.value.replace("$","")) : null;
                const statColor = pnl !== null ? (pnl >= 0 ? "#00FF41" : "#FF3A3A") : "#e0e0e0";
                return (
                  <motion.div
                    key={stat.label}
                    initial={{ opacity:0, y:8 }}
                    animate={{ opacity:1, y:0 }}
                    transition={{ delay: i * 0.05 }}
                    className="p-4 rounded-2xl"
                    style={{ background:"#0f0f0f", border:"1px solid rgba(255,255,255,0.05)" }}
                  >
                    <div className="text-void-700 text-xs font-display uppercase tracking-wider mb-2">
                      {stat.label}
                    </div>
                    <div
                      className="font-mono text-lg font-semibold"
                      style={{
                        color:      stat.colored ? statColor : "#e0e0e0",
                        fontFamily: "'JetBrains Mono', monospace",
                        textShadow: stat.colored ? `0 0 8px ${statColor}50` : "none",
                      }}
                    >
                      {stat.value}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </>
        )}

      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
//  AutoTradeToggle
//  A self-contained card component — renders identically whether account data
//  is present or not, so it can always be interacted with.
// ─────────────────────────────────────────────────────────────────────────────
function AutoTradeToggle({ isOn, toggling, error, onToggle }) {
  return (
    <motion.div
      // .border-glow-green from index.css is applied as a className;
      // we also animate the background tint to make the state change obvious.
      className={isOn ? "border-glow-green rounded-2xl" : "rounded-2xl"}
      animate={{
        background: isOn
          ? "rgba(0,255,65,0.06)"
          : "#0f0f0f",
      }}
      transition={{ duration: 0.25 }}
      style={{ border: `1px solid ${isOn ? "rgba(0,255,65,0.28)" : "rgba(255,255,255,0.07)"}` }}
    >
      <div className="p-4">
        {/* Row: icon + label + pill toggle */}
        <div className="flex items-center gap-3">

          {/* Icon cell */}
          <motion.div
            animate={{
              background: isOn ? "rgba(0,255,65,0.14)" : "rgba(255,255,255,0.04)",
            }}
            transition={{ duration:0.2 }}
            className="w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-shrink-0"
            style={{ border:`1px solid ${isOn ? "rgba(0,255,65,0.25)" : "rgba(255,255,255,0.06)"}` }}
          >
            {isOn ? "⚡" : "🤖"}
          </motion.div>

          {/* Label */}
          <div className="flex-1 min-w-0">
            <p className="text-white text-sm font-display tracking-wide">
              Master Auto-Trade
            </p>
            <motion.p
              animate={{ color: isOn ? "#00FF41" : "#4d4d4d" }}
              transition={{ duration:0.2 }}
              className="text-xs mt-0.5 font-display tracking-wide"
            >
              {isOn ? "ACTIVE — signals will execute automatically" : "OFF — signals monitored only"}
            </motion.p>
          </div>

          {/* Toggle pill — .active-scale from index.css for native press feel */}
          <button
            onClick={onToggle}
            disabled={toggling}
            aria-pressed={isOn}
            aria-label={isOn ? "Disable auto-trade" : "Enable auto-trade"}
            className="active-scale flex-shrink-0 relative"
            style={{
              background:  "transparent",
              border:      "none",
              cursor:      toggling ? "not-allowed" : "pointer",
              opacity:     toggling ? 0.65 : 1,
              padding:     0,
            }}
          >
            {toggling ? (
              /* Spinner while saving */
              <div className="w-14 h-7 flex items-center justify-center">
                <motion.div
                  animate={{ rotate:360 }}
                  transition={{ duration:0.6, repeat:Infinity, ease:"linear" }}
                  className="w-4 h-4 rounded-full border-2 border-transparent"
                  style={{ borderTopColor: isOn ? "#00FF41" : "#666" }}
                />
              </div>
            ) : (
              /* Pill switch */
              <motion.div
                animate={{
                  backgroundColor: isOn ? "#00FF41" : "#1f1f1f",
                }}
                transition={{ duration:0.2 }}
                className="w-14 h-7 rounded-full relative"
                style={{
                  border:`1px solid ${isOn ? "rgba(0,255,65,0.6)" : "rgba(255,255,255,0.1)"}`,
                  boxShadow: isOn ? "0 0 10px rgba(0,255,65,0.35)" : "none",
                }}
              >
                {/* Thumb */}
                <motion.div
                  animate={{ x: isOn ? 29 : 2 }}
                  transition={{ type:"spring", stiffness:480, damping:32 }}
                  className="absolute top-[3px] w-[20px] h-[20px] rounded-full"
                  style={{
                    background:  isOn ? "#000000" : "#555555",
                    boxShadow:   isOn ? "0 0 6px rgba(0,255,65,0.9)" : "none",
                  }}
                />
              </motion.div>
            )}
          </button>
        </div>

        {/* Warning banner — animates in when toggle is ON */}
        <AnimatePresence>
          {isOn && (
            <motion.div
              initial={{ opacity:0, height:0, marginTop:0 }}
              animate={{ opacity:1, height:"auto", marginTop:12 }}
              exit={{   opacity:0, height:0,      marginTop:0  }}
              className="overflow-hidden"
            >
              <div
                className="px-3 py-2 rounded-xl text-[11px] font-display tracking-wide leading-relaxed"
                style={{
                  background:"rgba(255,184,0,0.06)",
                  border:"1px solid rgba(255,184,0,0.18)",
                  color:"#FFB800",
                }}
              >
                ⚠ Live orders will be placed when a 100%-confluence SMC signal
                fires. Ensure your position sizing and Oanda API credentials are
                configured correctly before enabling.
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Error feedback */}
        <AnimatePresence>
          {error && (
            <motion.p
              initial={{ opacity:0, y:-4 }}
              animate={{ opacity:1,  y:0  }}
              exit={{   opacity:0          }}
              className="mt-2 text-[11px] font-display tracking-wide"
              style={{ color:"#FF3A3A" }}
            >
              ✕ {error}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}