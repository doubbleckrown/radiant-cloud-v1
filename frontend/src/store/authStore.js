/**
 * authStore — thin Zustand store for FX Radiant app-level settings.
 *
 * Identity (name, email, sessions, tokens) is now owned by Clerk.
 * This store only holds per-user backend settings fetched from
 * GET /api/auth/me after sign-in: auto_trade_enabled, risk_pct, etc.
 *
 * Components that need user identity should import Clerk hooks directly:
 *   import { useUser, useAuth } from "@clerk/clerk-react";
 *   const { user } = useUser();        // name, email, imageUrl
 *   const { getToken } = useAuth();    // fresh session token
 */
import { create } from "zustand";
import api from "../utils/api";

export const useAuthStore = create((set, get) => ({
  // ── Backend user settings (not Clerk identity) ──────────────────────────────
  auto_trade_enabled: false,
  risk_pct:           1.0,
  oanda_key_hint:     "",
  settingsLoaded:     false,

  // ── Fetch backend settings after Clerk sign-in ───────────────────────────────
  fetchMe: async () => {
    try {
      const { data } = await api.get("/auth/me");
      set({
        auto_trade_enabled: data.auto_trade_enabled ?? false,
        risk_pct:           data.risk_pct           ?? 1.0,
        oanda_key_hint:     data.oanda_key_hint      ?? "",
        settingsLoaded:     true,
      });
    } catch {
      // Non-fatal — store keeps defaults; will retry on next render
    }
  },

  // ── Toggle Master Auto-Trade (optimistic) ────────────────────────────────────
  updateAutoTrade: async (enabled) => {
    const prev = get().auto_trade_enabled;
    set({ auto_trade_enabled: enabled });  // optimistic
    try {
      const { data } = await api.patch("/users/me/settings", { auto_trade_enabled: enabled });
      set({ auto_trade_enabled: data.auto_trade_enabled });
    } catch (err) {
      set({ auto_trade_enabled: prev });  // rollback
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
}));