/**
 * authStore — Zustand store for FX Radiant app-level settings.
 *
 * Identity (name, email, sessions) is owned by Clerk.
 * This store holds:
 *   • Backend trading settings (auto_trade_enabled, risk_pct)
 *   • Oanda credential hints (hint + account_id — never the full key)
 *   • Bybit credential hints (key_hint + secret_hint — never the full secrets)
 *   • appMode: 'FOREX' | 'CRYPTO'  — persisted to localStorage
 *
 * Anti-flash strategy:
 *   • _readMode() runs synchronously at module-parse time, so Zustand's
 *     initial state already has the correct appMode before React renders.
 *   • Combined with the inline script in index.html, this fully eliminates
 *     the "flash of green" when refreshing in CRYPTO mode.
 */
import { create } from "zustand";
import api from "../utils/api";

// ── Read persisted appMode synchronously ──────────────────────────────────────
const _readMode = () => {
  try {
    const m = localStorage.getItem("fx-radiant-app-mode");
    return m === "CRYPTO" ? "CRYPTO" : "FOREX";
  } catch {
    return "FOREX";
  }
};

// ── Sync CSS custom properties + localStorage on every mode change ─────────────
// Keeps --accent / --accent-hdr in sync with React state so:
//   a) The pre-React CSS var usage in index.html never drifts
//   b) The range thumb CSS (which must be static) can use var(--accent)
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
  // ── App Mode — persisted ──────────────────────────────────────────────────
  // 'FOREX'  → Oanda engine  (Radiant Green  #00FF41)
  // 'CRYPTO' → Bybit engine  (Bybit Orange   #FFA500)
  appMode: _readMode(),

  toggleAppMode: () => {
    const next = get().appMode === "FOREX" ? "CRYPTO" : "FOREX";
    _persistMode(next);
    set({ appMode: next });
  },

  // ── Backend settings ──────────────────────────────────────────────────────
  auto_trade_enabled: false,
  risk_pct:           1.0,
  // Oanda hints — last 4 chars only, safe to hold in client state
  oanda_key_hint:     "",
  oanda_account_id:   "",
  // Bybit hints — "" means no personal key saved → backend uses global fallback key
  bybit_key_hint:     "",
  bybit_secret_hint:  "",
  settingsLoaded:     false,

  // ── Fetch backend settings after Clerk sign-in ────────────────────────────
  fetchMe: async () => {
    try {
      const { data } = await api.get("/auth/me");
      set({
        auto_trade_enabled: data.auto_trade_enabled ?? false,
        risk_pct:           data.risk_pct           ?? 1.0,
        oanda_key_hint:     data.oanda_key_hint      ?? "",
        oanda_account_id:   data.oanda_account_id    ?? "",
        bybit_key_hint:     data.bybit_key_hint      ?? "",
        bybit_secret_hint:  data.bybit_secret_hint   ?? "",
        settingsLoaded:     true,
      });
    } catch {
      // Non-fatal — keep defaults
    }
  },

  // ── Toggle Master Auto-Trade (optimistic) ─────────────────────────────────
  updateAutoTrade: async (enabled) => {
    const prev = get().auto_trade_enabled;
    set({ auto_trade_enabled: enabled });
    try {
      const { data } = await api.patch("/users/me/settings", { auto_trade_enabled: enabled });
      set({ auto_trade_enabled: data.auto_trade_enabled });
    } catch (err) {
      set({ auto_trade_enabled: prev });
      throw err;
    }
  },

  // ── Update any settings field ──────────────────────────────────────────────
  updateSettings: async (patch) => {
    try {
      const { data } = await api.patch("/users/me/settings", patch);
      set({
        auto_trade_enabled: data.auto_trade_enabled ?? get().auto_trade_enabled,
        risk_pct:           data.risk_pct           ?? get().risk_pct,
        oanda_key_hint:     data.oanda_key_hint      ?? get().oanda_key_hint,
      });
    } catch (err) {
      throw err;
    }
  },

  // ── Save Oanda credentials to Supabase via backend ────────────────────────
  saveOandaCredentials: async (oanda_api_key, oanda_account_id) => {
    const { data } = await api.post("/users/me/oanda-credentials", {
      oanda_api_key,
      oanda_account_id,
    });
    set({
      oanda_key_hint:   data.oanda_key_hint   ?? oanda_api_key.slice(-4),
      oanda_account_id: data.oanda_account_id ?? oanda_account_id,
    });
    return data;
  },

  // ── Save Bybit credentials to Supabase via backend ────────────────────────
  // The full API key + secret are sent once, verified by the backend, and
  // stored encrypted in Supabase. They are NEVER returned to the client.
  // Only the last-4-char hints are kept in state for display.
  //
  // Fallback: if no personal key is saved (bybit_key_hint === ""), the
  // backend automatically uses the global read-only BYBIT_PUBLIC_API_KEY
  // from its own .env so charts and market data still function.
  saveBybitCredentials: async (bybit_api_key, bybit_api_secret) => {
    const { data } = await api.post("/users/me/bybit-credentials", {
      bybit_api_key,
      bybit_api_secret,
    });
    set({
      bybit_key_hint:    data.bybit_key_hint    ?? bybit_api_key.slice(-4),
      bybit_secret_hint: data.bybit_secret_hint ?? bybit_api_secret.slice(-4),
    });
    return data;
  },
}));