import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  // Load .env so the dev-server proxy follows the same IP as the built app.
  // The proxy runs on the Mac (server-side), so we convert the VITE_API_URL
  // back to localhost when the host is a LAN IP — the proxy itself always
  // reaches the backend on the same machine.
  const env = loadEnv(mode, process.cwd(), "");

  // Proxy target: use env value if set, else fall back to localhost.
  // Note: when VITE_API_URL points to a LAN IP the proxy can still resolve
  // it because the Mac's own IP is reachable from itself.
  const apiTarget = env.VITE_API_URL  ?? "http://localhost:8000";
  const wsTarget  = env.VITE_WS_URL   ?? "ws://localhost:8000";

  return {
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
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
        navigateFallback: "index.html",
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\.fxradiant\.com\/api\//,
            handler:    "NetworkFirst",
            options:    { cacheName: "api-cache", expiration: { maxEntries: 50, maxAgeSeconds: 300 } },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    // Expose on all interfaces so physical Android/iOS devices on the same
    // Wi-Fi can load the Vite dev server at http://192.168.0.157:5173
    host: "0.0.0.0",
    proxy: {
      // Targets read from .env — no more hardcoded localhost
      "/api": { target: apiTarget, changeOrigin: true },
      "/ws":  { target: wsTarget,  ws: true, changeOrigin: true },
    },
  },
  build: {
    target:        "esnext",
    sourcemap:     false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor:        ["react", "react-dom"],
          motion:        ["framer-motion"],
          store:         ["zustand"],
        },
      },
    },
  },
  };
});