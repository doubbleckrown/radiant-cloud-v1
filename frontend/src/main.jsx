import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import App from "./App.jsx";
import "./index.css";

// ── Service Worker update → clean reload ──────────────────────────────────────
// WHY this exists:
//   vite.config.js uses skipWaiting:true — every new Vercel deployment
//   immediately activates a new SW mid-session.  Without this listener the old
//   page keeps running with orphaned JS chunk hashes that the new SW no longer
//   serves → blank screen on the next tab switch or lazy-import.
//
//   The `controllerchange` event fires the moment a new SW takes control.
//   Reloading here is safe for a trading app because all state lives on the
//   backend; a clean reload re-fetches everything fresh with the updated SW.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  });
}


// ── Global SW error guard ──────────────────────────────────────────────────────
// Belt-and-suspenders: catches any SW-related unhandled rejections before they
// can surface as a blank screen.  Must be the very first statement.
//
// WHY this is now largely redundant (but kept):
//   vite.config.js has skipWaiting:true in the workbox config.  This makes the
//   generated sw.js call self.skipWaiting() directly in its own install event —
//   no SKIP_WAITING postMessage is ever sent from the client side.
//   injectRegister:"auto" injects a plain navigator.serviceWorker.register()
//   call with no workbox-window class, so there is no lazy .then() timing gap.
//   The "postMessage / message handler must be added on initial evaluation"
//   errors are eliminated at source.  This guard remains for edge cases only
//   (HTTPS timing on first load, CDN path mismatches, etc.).
window.addEventListener("unhandledrejection", (event) => {
  const msg = event?.reason?.message ?? String(event?.reason ?? "");
  if (
    msg.includes("ServiceWorkerRegistration") ||
    msg.includes("postMessage") ||
    msg.includes("service worker") ||
    msg.includes("ServiceWorker")
  ) {
    console.warn("[PWA] Service worker issue (non-fatal, app fully functional):", msg);
    event.preventDefault();
  }
});

// ── NO manual SW registration ──────────────────────────────────────────────────
// injectRegister:"auto" in vite.config.js makes VitePWA inject a synchronous
// <script> into the built index.html that registers /sw.js directly.
// A second registration call here would race with that injected script and
// re-introduce the postMessage timing error we fixed.

// ── Missing-key safety screen ─────────────────────────────────────────────────
const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

function MissingKeyScreen() {
  return (
    <div style={{
      minHeight:      "100vh",
      background:     "#050505",
      display:        "flex",
      flexDirection:  "column",
      alignItems:     "center",
      justifyContent: "center",
      padding:        "32px 24px",
      fontFamily:     "'Inter', sans-serif",
      textAlign:      "center",
      gap:            20,
    }}>
      <div style={{
        width:          64,
        height:         64,
        borderRadius:   "50%",
        background:     "rgba(255,58,58,0.1)",
        border:         "1px solid rgba(255,58,58,0.35)",
        display:        "flex",
        alignItems:     "center",
        justifyContent: "center",
        fontSize:       "1.8rem",
      }}>
        🔑
      </div>

      <div>
        <h1 style={{ color: "#FF3A3A", fontSize: "1.1rem", fontWeight: 700, margin: "0 0 8px", letterSpacing: "0.04em" }}>
          Configuration Error
        </h1>
        <p style={{ color: "#aaaaaa", fontSize: "0.85rem", margin: "0 0 4px", lineHeight: 1.6 }}>
          <code style={{ color: "#ffffff", background: "rgba(255,255,255,0.08)", padding: "2px 6px", borderRadius: 4, fontSize: "0.8rem" }}>
            VITE_CLERK_PUBLISHABLE_KEY
          </code>
          {" "}is not set.
        </p>
        <p style={{ color: "#666666", fontSize: "0.78rem", margin: 0, lineHeight: 1.6 }}>
          Create a <code style={{ color: "#aaaaaa" }}>frontend/.env</code> file and add:
        </p>
      </div>

      <div style={{
        background:   "#0f0f0f",
        border:       "1px solid rgba(255,255,255,0.08)",
        borderRadius: 12,
        padding:      "14px 20px",
        maxWidth:     480,
        width:        "100%",
        textAlign:    "left",
      }}>
        <code style={{ color: "#00FF41", fontSize: "0.78rem", fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.8 }}>
          VITE_CLERK_PUBLISHABLE_KEY=pk_test_…
          <br />
          VITE_API_URL=https://fx-radiant-backend.onrender.com
          <br />
          VITE_WS_URL=wss://fx-radiant-backend.onrender.com/ws
        </code>
      </div>

      <p style={{ color: "#444444", fontSize: "0.72rem", maxWidth: 360, lineHeight: 1.6 }}>
        On Vercel: add the key in{" "}
        <strong style={{ color: "#666666" }}>Project → Settings → Environment Variables</strong>
        {" "}and redeploy.
      </p>
    </div>
  );
}

// ── Mount ─────────────────────────────────────────────────────────────────────
const root = ReactDOM.createRoot(document.getElementById("root"));

if (!PUBLISHABLE_KEY) {
  root.render(<MissingKeyScreen />);
} else {
  root.render(
    <React.StrictMode>
      <ClerkProvider
        publishableKey={PUBLISHABLE_KEY}

        // Account Portal hosted pages — paths set in Clerk Dashboard.
        signInUrl="https://immune-donkey-10.accounts.dev/sign-in"
        signUpUrl="https://immune-donkey-10.accounts.dev/sign-up"

        // `fallbackRedirectUrl` is the v5 replacement for deprecated `redirectUrl`.
        // Full absolute URL required when using Account Portal on a live domain.
        fallbackRedirectUrl="https://radiant-cloud-v1.vercel.app"
        signInFallbackRedirectUrl="https://radiant-cloud-v1.vercel.app"
        signUpFallbackRedirectUrl="https://radiant-cloud-v1.vercel.app"
        afterSignOutUrl="https://immune-donkey-10.accounts.dev/sign-in"
      >
        <App />
      </ClerkProvider>
    </React.StrictMode>
  );
}