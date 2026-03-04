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
        // ── CRITICAL: disable the auto-injected registration script ──────────
        // registerType: "autoUpdate" injects a script that calls
        // registration.waiting.postMessage({ type: 'SKIP_WAITING' }) with no
        // error handling.  On Render, if the SW can't register (wrong path,
        // HTTPS timing, CDN edge) this becomes an unhandled promise rejection
        // that fires before React mounts → blank screen.
        //
        // "prompt" skips the postMessage entirely.  We handle registration
        // manually in main.jsx with a full try/catch via virtual:pwa-register.
        registerType: "prompt",

        // ── Disable auto-injection — we register manually in main.jsx ────────
        // injectRegister: null means VitePWA does NOT inject any <script> tag.
        // The registerSW() call in main.jsx is the sole registration point,
        // so we control the error boundary around it.
        injectRegister: null,

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

          // ── navigateFallback guard ────────────────────────────────────────
          // Without a denylist the SW intercepts every URL including /api/*
          // and /ws — returning index.html for API requests breaks the app
          // on Render where static assets and the API are on different hosts.
          navigateFallback: "index.html",
          navigateFallbackDenylist: [
            /^\/api\//,      // backend REST routes
            /^\/ws/,         // WebSocket upgrade path
            /\.[a-z]+$/i,    // any URL with a file extension (assets)
          ],

          // Evict caches from old SW versions so a previously broken SW
          // doesn't serve stale assets after a deploy.
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