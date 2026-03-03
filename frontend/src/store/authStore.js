/**
 * authStore v3 — Private Bot Mode
 * ══════════════════════════════════════════════════════════════════════════════
 * Architecture shift: all trading credentials live in .env on the server.
 * The client only needs to know:
 *   • appMode: 'FOREX' | 'CRYPTO' (persisted to localStorage)
 *   • Whether Clerk auth is loaded (settingsLoaded)
 *
 * Removed in v3:
 *   • per-user credential hints (oanda_key_hint, bybit_key_hint, etc.)
 *   • saveOandaCredentials / saveBybitCredentials
 *   • updateAutoTrade / auto_trade_enabled
 *   • bybit_auto_trade / bybit_leverage / bybit_margin_type
 *   • updateSettings / fetchMe
 *
 * The backend auto-executes at 100% confluence using its own .env keys.
 */
import { create } from "zustand";

// ── Synchronously read persisted appMode ──────────────────────────────────────
const _readMode = () => {
  try {
    const m = localStorage.getItem("fx-radiant-app-mode");
    return m === "CRYPTO" ? "CRYPTO" : "FOREX";
  } catch {
    return "FOREX";
  }
};

// ── Sync CSS custom properties + localStorage on every mode change ─────────────
const _persistMode = (mode) => {
  try {
    localStorage.setItem("fx-radiant-app-mode", mode);
    const isCrypto = mode === "CRYPTO";
    const r = document.documentElement;
    r.style.setProperty("--accent",     isCrypto ? "#FFA500"              : "#00FF41");
    r.style.setProperty("--accent-hdr", isCrypto ? "rgba(255,165,0,0.08)" : "rgba(0,255,65,0.08)");
    r.setAttribute("data-mode", isCrypto ? "CRYPTO" : "FOREX");
  } catch { /* storage unavailable */ }
};

export const useAuthStore = create((set, get) => ({
  // ── App Mode ────────────────────────────────────────────────────────────────
  appMode:        _readMode(),
  settingsLoaded: true,   // No async fetch needed — env handles credentials

  toggleAppMode: () => {
    const next = get().appMode === "FOREX" ? "CRYPTO" : "FOREX";
    _persistMode(next);
    set({ appMode: next });
  },
}));