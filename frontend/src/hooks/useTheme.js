/**
 * useTheme — derive all accent-colour tokens from the current appMode.
 *
 * FOREX  → Radiant Green  #00FF41
 * CRYPTO → Bybit Orange   #FF9900
 *
 * Every page/component that needs dynamic colours calls this hook instead
 * of using hardcoded constants.
 */
import { useAuthStore } from "../store/authStore";

// ── Per-mode token tables ─────────────────────────────────────────────────────
const FOREX_TOKENS = {
  accent:      "#00FF41",
  accentDim:   "rgba(0,255,65,0.12)",
  accentBdr:   "rgba(0,255,65,0.25)",
  accentFaint: "rgba(0,255,65,0.08)",
  accentGlow:  "rgba(0,255,65,0.07)",
  accentHdr:   "rgba(0,255,65,0.08)",
  scanline:    "rgba(0,255,65,0.08)",
  modeName:    "FOREX",
  modeLabel:   "Oanda FX",
  modeIcon:    "📈",
};

const CRYPTO_TOKENS = {
  accent:      "#FF9900",
  accentDim:   "rgba(255,153,0,0.12)",
  accentBdr:   "rgba(255,153,0,0.25)",
  accentFaint: "rgba(255,153,0,0.08)",
  accentGlow:  "rgba(255,153,0,0.07)",
  accentHdr:   "rgba(255,153,0,0.08)",
  scanline:    "rgba(255,153,0,0.06)",
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