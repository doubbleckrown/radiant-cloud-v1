import axios from "axios";

// ---------------------------------------------------------------------------
// Base URL comes from .env (VITE_API_URL).  The ?? fallback is only used when
// running directly in a browser without a built env — e.g. unit tests.
// ---------------------------------------------------------------------------
const api = axios.create({
  baseURL: (import.meta.env.VITE_API_URL ?? "http://localhost:8000") + "/api",
  timeout: 15_000,
});

// ── Request interceptor ─────────────────────────────────────────────────────
// Token is already set on axios defaults by authStore.restoreToken() — nothing
// extra needed here, but keeping the interceptor makes it easy to add
// per-request logic later (e.g. request ID tracing).
api.interceptors.request.use((config) => config);

// ── Response interceptor ────────────────────────────────────────────────────
// Enriches every rejected promise with a human-readable `userMessage` string
// so components can just display `error.userMessage` without their own logic.
//
// Error taxonomy:
//   • No response at all  → network is down / backend not running
//                           userMessage = "Server Offline"
//   • HTTP 401            → JWT is missing, expired, or invalid
//                           → also auto-logout so the user lands back on login
//   • HTTP 503            → backend reached Oanda but Oanda rejected/timed-out
//                           → most likely a bad OANDA_API_KEY or account ID
//   • Any other HTTP code → surface the detail from the backend JSON body
api.interceptors.response.use(
  (res) => res,
  async (error) => {
    if (!error.response) {
      // ── Network / Connection Refused ──────────────────────────────────────
      // error.request exists (the request was made) but no response arrived.
      // This is the "Connection Refused" / "Server Offline" case.
      error.userMessage =
        "Server Offline — make sure the backend is running on 192.168.0.157:8000";
      return Promise.reject(error);
    }

    const { status, data } = error.response;

    if (status === 401) {
      // ── Expired / invalid JWT ─────────────────────────────────────────────
      // Silently log the user out so they land on the login screen.
      error.userMessage = "Session expired — please log in again";
      const { useAuthStore } = await import("../store/authStore");
      useAuthStore.getState().logout();

    } else if (status === 503) {
      // ── Oanda upstream error ──────────────────────────────────────────────
      // The backend is up but Oanda rejected the request.  Almost always a
      // bad API key or account ID in the backend .env.
      error.userMessage =
        "Oanda API unavailable — check OANDA_API_KEY and OANDA_ACCOUNT_ID in backend .env";

    } else {
      // ── All other HTTP errors ─────────────────────────────────────────────
      error.userMessage =
        data?.detail ?? data?.message ?? `Request failed (${status})`;
    }

    return Promise.reject(error);
  }
);

export default api;