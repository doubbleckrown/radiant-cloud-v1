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
        // Workbox generates sw.js with precaching + a top-level message listener.
        // registerType:"prompt" means the injected <script> (injectRegister:"auto")
        // does NOT send a SKIP_WAITING postMessage from the client.
        // Instead, skipWaiting:true below makes the SW call self.skipWaiting()
        // directly in its own install handler — no client postMessage at all.
        // This is what eliminates the "postMessage / message handler timing" error.
        registerType: "prompt",

        // ── injectRegister:"auto" ─────────────────────────────────────────────
        // VitePWA injects a tiny synchronous <script> into the built index.html
        // that calls navigator.serviceWorker.register('/sw.js') directly.
        // No workbox-window class, no lazy .then() chain, no timing gap between
        // the SW's message listener being parsed and a postMessage arriving.
        injectRegister: "auto",

        // Assets that exist in /public and must be included in the precache.
        // favicon.ico is the uploaded icon — keep it consistent with index.html.
        includeAssets: ["favicon.ico", "icon-192.png", "icon-512.png"],

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
            // ── IMPORTANT: split 'any' and 'maskable' into separate entries ──
            // Chrome Lighthouse (and the PWA installability check) require
            // at least one icon with purpose:"any" AND one with purpose:"maskable".
            // Combining them as "any maskable" on one entry used to work but
            // now triggers a warning and may block install on some browsers.
            { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any"      },
            { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
            { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any"      },
            { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
        },

        workbox: {
          // ── skipWaiting + clientsClaim ────────────────────────────────────
          // skipWaiting:true  → generated sw.js calls self.skipWaiting() in
          //   the install event. New SW takes over immediately without waiting
          //   for existing tabs to close. No SKIP_WAITING postMessage needed
          //   from the client — this is what eliminates the postMessage error.
          // clientsClaim:true → once the new SW activates it immediately claims
          //   all open tabs, so users get the new version without a reload.
          skipWaiting:    true,
          clientsClaim:   true,

          globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],

          // ── navigateFallback guard ────────────────────────────────────────
          // Prevents the SW intercepting /api/* and /ws/* requests and returning
          // index.html — breaks Render's static CDN / separate API origin.
          navigateFallback: "index.html",
          navigateFallbackDenylist: [
            /^\/api\//,       // backend REST routes
            /^\/ws/,          // WebSocket upgrade path
            /\.[a-z0-9]+$/i,  // any URL with a file extension (assets)
          ],

          // Evict caches from stale SW versions after each deploy.
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