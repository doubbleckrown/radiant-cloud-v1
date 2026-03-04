import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import App from "./App.jsx";
import "./index.css";

// ── Global SW error guard ──────────────────────────────────────────────────────
// Must be registered BEFORE anything else so it catches SW promise rejections
// that fire during the registration attempt (which happens in a microtask
// before React even mounts).
//
// The specific message "Could not get ServiceWorkerRegistration to postMessage"
// comes from Workbox's skipWaiting flow failing — it is non-fatal (the app
// works fine without an SW update), but without this handler it surfaces as an
// uncaught rejection that React's error overlay or the browser treats as a
// fatal error, producing a blank screen.
window.addEventListener("unhandledrejection", (event) => {
  const msg = event?.reason?.message ?? String(event?.reason ?? "");
  if (
    msg.includes("ServiceWorkerRegistration") ||
    msg.includes("postMessage") ||
    msg.includes("service worker") ||
    msg.includes("ServiceWorker")
  ) {
    // SW registration failed — app is fully functional without it.
    console.warn("[PWA] Service worker registration issue (non-fatal):", msg);
    event.preventDefault();   // stops the browser treating it as uncaught
  }
});

// ── Service-worker registration (manual, non-blocking) ────────────────────────
// We use virtual:pwa-register instead of letting VitePWA auto-inject a script.
// Auto-injection calls postMessage with no error handling; any failure there
// is unhandled and kills the page.  Here every failure path is caught.
//
// The import is wrapped in a dynamic import so a bundler error (e.g. the
// virtual module not resolving in test/SSR environments) doesn't crash the
// module before React mounts.
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  import("virtual:pwa-register")
    .then(({ registerSW }) => {
      registerSW({
        // Called once the SW is registered and active.
        onRegisteredSW(swUrl, registration) {
          console.info("[PWA] Service worker registered:", swUrl);

          // Periodically check for updates (every 60 min while the tab is open).
          if (registration) {
            setInterval(() => {
              registration.update().catch(() => {
                // update() can fail if the network is offline — ignore silently.
              });
            }, 60 * 60 * 1000);
          }
        },

        // Called if registration itself fails (wrong path, HTTPS issue, etc.).
        // Log and continue — the app is fully functional without an SW.
        onRegisterError(error) {
          console.warn("[PWA] Service worker registration failed (non-fatal):", error);
        },
      });
    })
    .catch((err) => {
      // The virtual:pwa-register module itself failed to load (e.g. dev mode
      // with injectRegister:null and no sw.js built yet).  Safe to ignore.
      console.warn("[PWA] Could not load SW register module (non-fatal):", err);
    });
}

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
        afterSignOutUrl="/"
      >
        <App />
      </ClerkProvider>
    </React.StrictMode>
  );

  // Register SW AFTER React mounts so a SW failure never blocks the render.
  // requestIdleCallback (where available) defers it further until the browser
  // is idle — keeps the initial paint fast.
  if (typeof requestIdleCallback !== "undefined") {
    requestIdleCallback(registerServiceWorker);
  } else {
    setTimeout(registerServiceWorker, 100);
  }
}