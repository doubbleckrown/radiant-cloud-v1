import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import App from "./App.jsx";
import "./index.css";

// ── Global SW error guard ──────────────────────────────────────────────────────
// Catches any SW-related unhandled promise rejections so they never surface
// as a blank screen.  Must be the very first thing that runs.
//
// With injectRegister:"auto", VitePWA injects a synchronous <script> into
// index.html that registers the SW directly — no workbox-window, no lazy
// class instantiation, so the "message handler must be added on initial
// evaluation" timing error is eliminated at source.
// This guard is kept as a belt-and-suspenders fallback for edge cases
// (HTTPS cert delays, CDN path issues, etc.) that can still produce
// unhandled rejections from the injected registration script.
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

// ── NOTE: No manual SW registration here ──────────────────────────────────────
// With injectRegister:"auto" in vite.config.js, VitePWA injects a tiny
// synchronous <script> into the built index.html that registers /sw.js.
// Adding a SECOND registration call here via virtual:pwa-register would create
// a race condition and re-introduce the message-handler timing error we just
// fixed.  Leave SW lifecycle entirely to VitePWA's injected script.

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
}