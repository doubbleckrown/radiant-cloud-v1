/**
 * authStore — Zustand store for FX Radiant app-level settings.
 *
 * Identity (name, email, sessions) is owned by Clerk.
 * This store holds:
 *   • Backend trading settings (auto_trade_enabled, risk_pct)
 *   • Oanda credential status (hint + account_id — never the full key)
 */
import { create } from "zustand";
import api from "../utils/api";

export const useAuthStore = create((set, get) => ({
  // ── Backend settings ────────────────────────────────────────────────────────
  auto_trade_enabled: false,
  risk_pct:           1.0,
  oanda_key_hint:     "",        // last 4 chars of API key, safe to display
  oanda_account_id:   "",        // account ID (not secret, OK to display)
  settingsLoaded:     false,

  // ── Fetch backend settings after Clerk sign-in ───────────────────────────────
  fetchMe: async () => {
    try {
      const { data } = await api.get("/auth/me");
      set({
        auto_trade_enabled: data.auto_trade_enabled ?? false,
        risk_pct:           data.risk_pct           ?? 1.0,
        oanda_key_hint:     data.oanda_key_hint      ?? "",
        oanda_account_id:   data.oanda_account_id    ?? "",
        settingsLoaded:     true,
      });
    } catch {
      // Non-fatal — keep defaults
    }
  },

  // ── Toggle Master Auto-Trade (optimistic) ────────────────────────────────────
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

  // ── Update any settings field ─────────────────────────────────────────────────
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

  // ── Save Oanda credentials to Supabase via backend ───────────────────────────
  // Sends the full API key + account ID to POST /api/users/me/oanda-credentials.
  // Backend verifies them against Oanda before storing in Supabase.
  // On success, only the hint + account_id are stored in local state.
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
}));