/**
 * useTheme — derive all accent-color tokens from the current appMode.
 *
 * FOREX  → Radiant Green  #00FF41
 * CRYPTO → Bybit Orange   #FFA500
 *
 * Every page/component that needs dynamic colors calls this hook instead
 * of using hardcoded C.green.  The Oanda-specific C constant objects in
 * each page remain untouched — they are used as fallbacks and for
 * non-accent colors (red, amber, white, label, sub, card, cardBdr, sheet).
 */
import { useAuthStore } from "../store/authStore";

// ── Per-mode token tables ─────────────────────────────────────────────────────
const FOREX_TOKENS = {
  accent:      "#00FF41",
  accentDim:   "rgba(0,255,65,0.12)",
  accentBdr:   "rgba(0,255,65,0.25)",
  accentFaint: "rgba(0,255,65,0.08)",
  accentGlow:  "rgba(0,255,65,0.07)",
  accentHdr:   "rgba(0,255,65,0.08)",   // header border-bottom
  scanline:    "rgba(0,255,65,0.08)",
  modeName:    "FOREX",
  modeLabel:   "Oanda FX",
  modeIcon:    "📈",
};

const CRYPTO_TOKENS = {
  accent:      "#FFA500",
  accentDim:   "rgba(255,165,0,0.12)",
  accentBdr:   "rgba(255,165,0,0.25)",
  accentFaint: "rgba(255,165,0,0.08)",
  accentGlow:  "rgba(255,165,0,0.07)",
  accentHdr:   "rgba(255,165,0,0.08)",
  scanline:    "rgba(255,165,0,0.06)",
  modeName:    "CRYPTO",
  modeLabel:   "Bybit",
  modeIcon:    "₿",
};

// ─────────────────────────────────────────────────────────────────────────────
export function useTheme() {
  const appMode  = useAuthStore((s) => s.appMode);
  const isCrypto = appMode === "CRYPTO";
  return {
    ...(isCrypto ? CRYPTO_TOKENS : FOREX_TOKENS),
    isCrypto,
    appMode,
  };
}