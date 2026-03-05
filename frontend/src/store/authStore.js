/**
 * authStore v4 — Private Bot Mode + Separate Risk Settings
 * ══════════════════════════════════════════════════════════════════════════════
 * Architecture: all trading credentials live in .env on the server.
 * The client manages:
 *   • appMode: 'FOREX' | 'CRYPTO' (persisted to localStorage)
 *   • oanda_risk_pct: per-user Oanda risk % (fetched from /api/profile)
 *   • bybit_risk_pct: per-user Bybit risk % (fetched from /api/profile)
 *
 * Risk values are kept separate because:
 *   - Oanda (FX): 0.5–10%, default 1% (larger capital, conservative sizing)
 *   - Bybit (crypto): 5–50%, default 20% (smaller capital, needs higher % per trade)
 *
 * Profile is fetched once after Clerk auth loads (call fetchProfile() from
 * the component that has access to the Clerk token, e.g. ProfilePage).
 */
import { create } from "zustand";
import axios from "axios";

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
  settingsLoaded: false,   // true once fetchProfile() resolves

  // ── Per-engine risk percentages ─────────────────────────────────────────────
  // Server defaults: oanda=1.0, bybit=20.0
  // These are display values (1.0 = 1%) — backend stores/returns same format.
  oanda_risk_pct: 1.0,
  bybit_risk_pct: 20.0,

  toggleAppMode: () => {
    const next = get().appMode === "FOREX" ? "CRYPTO" : "FOREX";
    _persistMode(next);
    set({ appMode: next });
  },

  // ── Fetch profile from backend ───────────────────────────────────────────────
  // Call this once after Clerk auth is ready (useEffect in ProfilePage or App).
  // token: the Clerk session token string (from useAuth().getToken()).
  fetchProfile: async (token) => {
    if (!token) return;
    try {
      const { data } = await axios.get("/api/profile", {
        headers: { Authorization: `Bearer ${token}` },
      });
      set({
        oanda_risk_pct: data.oanda_risk_pct ?? 1.0,
        bybit_risk_pct: data.bybit_risk_pct ?? 20.0,
        settingsLoaded: true,
      });
    } catch (err) {
      console.warn("[authStore] fetchProfile failed:", err?.response?.data ?? err.message);
      set({ settingsLoaded: true }); // still mark loaded so UI doesn't hang
    }
  },

  // ── Update Oanda risk % ──────────────────────────────────────────────────────
  // pct: display value e.g. 1.0 for 1%
  updateOandaRisk: async (pct, token) => {
    const clamped = Math.max(0.5, Math.min(10.0, parseFloat(pct)));
    set({ oanda_risk_pct: clamped }); // optimistic update
    await axios.post(
      "/api/profile/update",
      { oanda_risk_pct: clamped },
      { headers: { Authorization: `Bearer ${token}` } },
    );
  },

  // ── Update Bybit risk % ──────────────────────────────────────────────────────
  // pct: display value e.g. 20.0 for 20%
  updateBybitRisk: async (pct, token) => {
    const clamped = Math.max(5.0, Math.min(50.0, parseFloat(pct)));
    set({ bybit_risk_pct: clamped }); // optimistic update
    await axios.post(
      "/api/profile/update",
      { bybit_risk_pct: clamped },
      { headers: { Authorization: `Bearer ${token}` } },
    );
  },
}));