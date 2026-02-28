import axios from "axios";

// ---------------------------------------------------------------------------
// Axios instance — base URL from .env
// ---------------------------------------------------------------------------
const api = axios.create({
  baseURL: (import.meta.env.VITE_API_URL ?? "http://localhost:8000") + "/api",
  timeout: 15_000,
});

// ── Request interceptor — attach Clerk token automatically ──────────────────
// Clerk's ClerkProvider sets window.Clerk.  We grab the fresh session token
// before every request so the Bearer header is always current.
// Clerk tokens are short-lived (~60 s) but getToken() returns a cached value
// and only fetches a new one when the cached one is within ~10 s of expiry.
api.interceptors.request.use(async (config) => {
  try {
    const token = await window.Clerk?.session?.getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  } catch {
    // Session not ready yet (e.g. during initial load) — request proceeds
    // without auth and the backend returns 401 which is handled below.
  }
  return config;
});

// ── Response interceptor — human-readable error messages ───────────────────
api.interceptors.response.use(
  (res) => res,
  async (error) => {
    if (!error.response) {
      error.userMessage =
        "Server Offline — cannot reach the backend. Check your internet connection.";
      return Promise.reject(error);
    }

    const { status, data } = error.response;

    if (status === 401) {
      error.userMessage = "Session expired — please sign in again";
    } else if (status === 503) {
      error.userMessage =
        "Oanda API unavailable — check OANDA_API_KEY and OANDA_ACCOUNT_ID in backend .env";
    } else {
      error.userMessage =
        data?.detail ?? data?.message ?? `Request failed (${status})`;
    }

    return Promise.reject(error);
  }
);

export default api;