import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  const apiTarget = env.VITE_API_URL ?? "http://localhost:8000";
  const wsTarget  = env.VITE_WS_URL  ?? "ws://localhost:8000";

  return {
    plugins: [
      react(),
      VitePWA({
        // ── GenerateSW mode (default) ─────────────────────────────────────────
        // Workbox auto-generates sw.js containing:
        //   precacheAndRoute(self.__WB_MANIFEST)
        //   self.addEventListener('message', ...) ← top-level, always synchronous
        //
        // "prompt" means: do NOT call self.skipWaiting() automatically.
        // Instead the generated SW waits for a SKIP_WAITING postMessage.
        // The injected registration script (injectRegister:"auto") sends that
        // message when appropriate — no workbox-window, no timing ambiguity.
        registerType: "prompt",

        // ── injectRegister: "auto" — the critical change from our last fix ────
        // Previously we used injectRegister:null + virtual:pwa-register in
        // main.jsx.  That routes through workbox-window which instantiates a
        // Workbox class inside a lazy .then() callback, then calls postMessage
        // on the waiting SW.  Chrome fires:
        //   "Event handler of 'message' event must be added on the initial
        //    evaluation of worker script"
        // because the message arrives while the SW may still be activating and
        // the browser can't confirm the listener was registered synchronously.
        //
        // "auto" makes VitePWA inject a tiny SYNCHRONOUS <script> into index.html
        // that calls navigator.serviceWorker.register('/sw.js') directly.
        // No workbox-window. No class instantiation. No timing gap.
        // The SW's top-level message listener is always fully parsed before
        // any postMessage is ever sent.
        injectRegister: "auto",

        includeAssets: ["favicon.svg", "icon-192.png", "icon-512.png"],

        manifest: {
          name:             "FX Radiant",
          short_name:       "FX Radiant",
          description:      "Smart Money Concepts trading platform",
          theme_color:      "#050505",
          background_color: "#050505",
          display:          "standalone",
          orientation:      "portrait",
          start_url:        "/",
          icons: [
            { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
          ],
        },

        workbox: {
          globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],

          // Prevents the SW intercepting backend API calls and returning
          // index.html for them (breaks Render's separate static/API origins).
          navigateFallback: "index.html",
          navigateFallbackDenylist: [
            /^\/api\//,       // backend REST routes
            /^\/ws/,          // WebSocket upgrade path
            /\.[a-z0-9]+$/i,  // any URL with a file extension (assets)
          ],

          // Evict caches from old SW versions after a deploy.
          cleanupOutdatedCaches: true,

          runtimeCaching: [
            {
              urlPattern: /^https:\/\/api\.fxradiant\.com\/api\//,
              handler:    "NetworkFirst",
              options: {
                cacheName:  "api-cache",
                expiration: { maxEntries: 50, maxAgeSeconds: 300 },
              },
            },
          ],
        },
      }),
    ],

    server: {
      port: 5173,
      host: "0.0.0.0",
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true },
        "/ws":  { target: wsTarget,  ws: true, changeOrigin: true },
      },
    },

    build: {
      target:    "esnext",
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ["react", "react-dom"],
            motion: ["framer-motion"],
            store:  ["zustand"],
          },
        },
      },
    },
  };
});