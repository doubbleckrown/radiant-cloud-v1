import { create } from "zustand";
import { persist } from "zustand/middleware";
import api from "../utils/api";

export const useAuthStore = create(
  persist(
    (set, get) => ({
      user:            null,
      token:           null,
      refreshToken:    null,
      isAuthenticated: false,

      login: async (email, password) => {
        const form = new URLSearchParams({ username: email, password });
        const { data } = await api.post("/auth/login", form, {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        set({
          token:           data.access_token,
          refreshToken:    data.refresh_token,
          // Merge auto_trade_enabled returned by /api/auth/login → /api/auth/me
          user:            data.user,
          isAuthenticated: true,
        });
        api.defaults.headers.common["Authorization"] = `Bearer ${data.access_token}`;
        // Hydrate auto_trade_enabled from the server immediately after login
        await get().fetchMe();
      },

      signup: async (email, password, name) => {
        const { data } = await api.post("/auth/signup", { email, password, name });
        set({
          token:           data.access_token,
          refreshToken:    data.refresh_token,
          user:            data.user,
          isAuthenticated: true,
        });
        api.defaults.headers.common["Authorization"] = `Bearer ${data.access_token}`;
        await get().fetchMe();
      },

      logout: () => {
        set({ user: null, token: null, refreshToken: null, isAuthenticated: false });
        delete api.defaults.headers.common["Authorization"];
      },

      restoreToken: () => {
        const { token } = get();
        if (token) {
          api.defaults.headers.common["Authorization"] = `Bearer ${token}`;
        }
      },

      // Refresh the full user profile from the server (picks up auto_trade_enabled etc.)
      fetchMe: async () => {
        try {
          const { data } = await api.get("/auth/me");
          set((s) => ({ user: { ...s.user, ...data } }));
        } catch {
          // Non-fatal — user is still authenticated, settings just won't be pre-loaded
        }
      },

      // Toggle Master Auto-Trade.
      // Performs an optimistic update so the UI responds instantly,
      // then PATCHes the backend.  Rolls back on failure.
      updateAutoTrade: async (enabled) => {
        const prev = get().user?.auto_trade_enabled ?? false;
        // Optimistic update
        set((s) => ({ user: { ...s.user, auto_trade_enabled: enabled } }));
        try {
          const { data } = await api.patch("/users/me/settings", {
            auto_trade_enabled: enabled,
          });
          // Confirm with server value in case backend normalised it
          set((s) => ({ user: { ...s.user, auto_trade_enabled: data.auto_trade_enabled } }));
        } catch (err) {
          // Roll back on failure
          set((s) => ({ user: { ...s.user, auto_trade_enabled: prev } }));
          throw err;
        }
      },
    }),
    {
      name: "fx-radiant-auth",
      partialize: (state) => ({
        token:           state.token,
        refreshToken:    state.refreshToken,
        user:            state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);