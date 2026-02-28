/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // ── Brand ────────────────────────────────────────────────────────────
        radiant: {
          50:  "#e6fff0",
          100: "#b3ffcc",
          200: "#80ffa8",
          300: "#4dff84",
          400: "#1aff60",
          500: "#00FF41",   // Radiant Green — primary
          600: "#00cc34",
          700: "#009927",
          800: "#00661a",
          900: "#00330d",
        },
        // ── OLED Blacks ───────────────────────────────────────────────────────
        void: {
          DEFAULT: "#050505",  // OLED pure black
          50:  "#0f0f0f",
          100: "#141414",
          200: "#1a1a1a",
          300: "#1f1f1f",
          400: "#2a2a2a",
          500: "#333333",
          // 600-900 are used as "muted label" text on dark cards.
          // Values below #888 on #0f0f0f fail WCAG AA contrast.
          // These are deliberately lightened so labels are readable on iPhone.
          600: "#666666",   // was #404040 — contrast fix
          700: "#999999",   // was #4d4d4d — contrast fix (≈5.2:1 on #0f0f0f)
          800: "#bbbbbb",   // was #666666 — contrast fix
          900: "#d4d4d4",   // was #808080 — contrast fix
        },
        // ── Semantic ──────────────────────────────────────────────────────────
        bull:   "#00FF41",   // same as radiant-500 (long / buy)
        bear:   "#FF3A3A",   // red for short / sell
        warn:   "#FFB800",   // amber warning
        ghost:  "#404040",   // muted borders
        surface: "#0f0f0f",  // card / panel background
        overlay: "#141414",  // modal / drawer background
      },

      // ── Background colors ─────────────────────────────────────────────────
      backgroundColor: {
        app:     "#050505",
        card:    "#0f0f0f",
        sheet:   "#141414",
        input:   "#1a1a1a",
      },

      // ── Typography ────────────────────────────────────────────────────────
      fontFamily: {
        display: ["'Share Tech Mono'", "monospace"],  // terminal / HUD feel
        body:    ["'DM Sans'", "sans-serif"],
        mono:    ["'JetBrains Mono'", "monospace"],
      },

      fontSize: {
        "2xs": ["0.625rem", { lineHeight: "0.875rem" }],
      },

      // ── Spacing ───────────────────────────────────────────────────────────
      spacing: {
        "safe-top":    "env(safe-area-inset-top)",
        "safe-bottom": "env(safe-area-inset-bottom)",
        "safe-left":   "env(safe-area-inset-left)",
        "safe-right":  "env(safe-area-inset-right)",
        "tab-bar":     "72px",   // bottom tab bar height
      },

      // ── Border radius ─────────────────────────────────────────────────────
      borderRadius: {
        "4xl": "2rem",
        "5xl": "2.5rem",
      },

      // ── Box shadows — Neon glow system ────────────────────────────────────
      boxShadow: {
        "neon-sm": "0 0 8px rgba(0, 255, 65, 0.4), 0 0 16px rgba(0, 255, 65, 0.15)",
        "neon":    "0 0 16px rgba(0, 255, 65, 0.5), 0 0 32px rgba(0, 255, 65, 0.2)",
        "neon-lg": "0 0 32px rgba(0, 255, 65, 0.6), 0 0 64px rgba(0, 255, 65, 0.25)",
        "neon-xl": "0 0 48px rgba(0, 255, 65, 0.7), 0 0 96px rgba(0, 255, 65, 0.3)",
        "bear-sm": "0 0 8px rgba(255, 58, 58, 0.4), 0 0 16px rgba(255, 58, 58, 0.15)",
        "bear":    "0 0 16px rgba(255, 58, 58, 0.5), 0 0 32px rgba(255, 58, 58, 0.2)",
        "card":    "0 1px 3px rgba(0,0,0,0.9), 0 4px 12px rgba(0,0,0,0.6)",
        "sheet":   "0 -8px 32px rgba(0,0,0,0.8)",
      },

      // ── Text shadows ──────────────────────────────────────────────────────
      dropShadow: {
        "neon": ["0 0 6px rgba(0, 255, 65, 0.8)", "0 0 12px rgba(0, 255, 65, 0.4)"],
        "bear": ["0 0 6px rgba(255, 58, 58, 0.8)", "0 0 12px rgba(255, 58, 58, 0.4)"],
      },

      // ── Animations ────────────────────────────────────────────────────────
      keyframes: {
        "flicker-up": {
          "0%":   { color: "inherit" },
          "25%":  { color: "#00FF41", textShadow: "0 0 8px rgba(0,255,65,0.8)" },
          "100%": { color: "inherit" },
        },
        "flicker-down": {
          "0%":   { color: "inherit" },
          "25%":  { color: "#FF3A3A", textShadow: "0 0 8px rgba(255,58,58,0.8)" },
          "100%": { color: "inherit" },
        },
        "pulse-neon": {
          "0%, 100%": { boxShadow: "0 0 8px rgba(0,255,65,0.3)" },
          "50%":      { boxShadow: "0 0 24px rgba(0,255,65,0.8), 0 0 48px rgba(0,255,65,0.3)" },
        },
        "slide-up": {
          "from": { transform: "translateY(100%)", opacity: 0 },
          "to":   { transform: "translateY(0)",    opacity: 1 },
        },
        "fade-in": {
          "from": { opacity: 0 },
          "to":   { opacity: 1 },
        },
        "scan-line": {
          "0%":   { backgroundPosition: "0 0" },
          "100%": { backgroundPosition: "0 100%" },
        },
        "ticker": {
          "0%":   { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
        "signal-burst": {
          "0%":   { transform: "scale(0.8)", opacity: 0 },
          "50%":  { transform: "scale(1.05)", opacity: 1 },
          "100%": { transform: "scale(1)",   opacity: 1 },
        },
      },

      animation: {
        "flicker-up":   "flicker-up 0.4s ease-out",
        "flicker-down": "flicker-down 0.4s ease-out",
        "pulse-neon":   "pulse-neon 2s ease-in-out infinite",
        "slide-up":     "slide-up 0.35s cubic-bezier(0.32, 0.72, 0, 1)",
        "fade-in":      "fade-in 0.3s ease-out",
        "ticker":       "ticker 30s linear infinite",
        "signal-burst": "signal-burst 0.5s cubic-bezier(0.32, 0.72, 0, 1)",
      },
    },
  },
  plugins: [],
}