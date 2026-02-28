/**
 * AuthPage — Clerk-hosted Sign-In / Sign-Up, styled to match the Radiant
 * OLED-black aesthetic.
 *
 * Clerk's <SignIn /> and <SignUp /> are pre-built, pre-validated components
 * that handle all edge cases (email verification, OAuth, error states).
 * We provide appearance overrides to make them look native to FX Radiant.
 */
import { useState } from "react";
import { SignIn, SignUp } from "@clerk/clerk-react";

// ── Clerk appearance overrides — Radiant Green on OLED Black ─────────────────
const clerkAppearance = {
  layout: {
    logoPlacement:   "none",  // we render our own logo above
    showOptionalFields: false,
  },
  variables: {
    colorBackground:        "#0a0a0a",
    colorInputBackground:   "#111111",
    colorText:              "#ffffff",
    colorTextSecondary:     "#aaaaaa",
    colorPrimary:           "#00FF41",
    colorDanger:            "#FF3A3A",
    colorNeutral:           "#333333",
    borderRadius:           "12px",
    fontFamily:             "'DM Sans', sans-serif",
    fontSize:               "14px",
  },
  elements: {
    // Root card
    card: {
      background:   "#0a0a0a",
      border:       "1px solid rgba(0,255,65,0.12)",
      boxShadow:    "0 0 40px rgba(0,255,65,0.06)",
      borderRadius: "20px",
      padding:      "28px 24px",
    },
    // Primary action button
    formButtonPrimary: {
      background:    "#00FF41",
      color:         "#050505",
      fontWeight:    "600",
      fontSize:      "14px",
      letterSpacing: "0.04em",
      borderRadius:  "12px",
      border:        "none",
      boxShadow:     "0 0 16px rgba(0,255,65,0.35)",
    },
    // Input fields
    formFieldInput: {
      background:  "#111111",
      border:      "1px solid rgba(255,255,255,0.08)",
      color:       "#ffffff",
      borderRadius:"10px",
    },
    // Input label
    formFieldLabel: {
      color:    "#aaaaaa",
      fontSize: "12px",
    },
    // Footer links (sign in ↔ sign up toggle)
    footerActionLink: {
      color:      "#00FF41",
      fontWeight: "500",
    },
    // Social / OAuth buttons
    socialButtonsBlockButton: {
      background:   "#141414",
      border:       "1px solid rgba(255,255,255,0.08)",
      color:        "#ffffff",
      borderRadius: "10px",
    },
    // Divider
    dividerLine:    { background: "rgba(255,255,255,0.07)" },
    dividerText:    { color: "#555555" },
    // Inner header
    headerTitle:    { color: "#ffffff", fontWeight: "600" },
    headerSubtitle: { color: "#aaaaaa" },
    // Error messages
    formFieldErrorText: { color: "#FF3A3A" },
    alertText:          { color: "#FF3A3A" },
  },
};

export default function AuthPage() {
  const [mode, setMode] = useState("signIn"); // "signIn" | "signUp"

  return (
    <div
      style={{
        minHeight:      "100vh",
        background:     "#050505",
        display:        "flex",
        flexDirection:  "column",
        alignItems:     "center",
        justifyContent: "center",
        padding:        "24px",
        fontFamily:     "'DM Sans', sans-serif",
      }}
    >
      {/* ── Logo & tagline ─────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 32, textAlign: "center" }}>
        {/* Neon dot */}
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
          <div style={{
            width:        40,
            height:       40,
            borderRadius: "50%",
            background:   "radial-gradient(circle, #00FF41 0%, rgba(0,255,65,0.15) 70%, transparent 100%)",
            boxShadow:    "0 0 24px rgba(0,255,65,0.6)",
          }} />
        </div>

        <h1 style={{
          fontSize:      24,
          fontWeight:    700,
          color:         "#ffffff",
          letterSpacing: "0.06em",
          margin:        0,
        }}>
          FX <span style={{ color: "#00FF41" }}>RADIANT</span>
        </h1>

        <p style={{
          fontSize:      11,
          color:         "#aaaaaa",
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          marginTop:     6,
        }}>
          Smart Money · Institutional Edge
        </p>
      </div>

      {/* ── Clerk SignIn or SignUp ──────────────────────────────────────────── */}
      {mode === "signIn" ? (
        <SignIn
          appearance={clerkAppearance}
          routing="hash"
          afterSignInUrl="/"
          signUpUrl="#"
          // Override Clerk's built-in sign-up link with our own toggle
          afterSignUpUrl="/"
        />
      ) : (
        <SignUp
          appearance={clerkAppearance}
          routing="hash"
          afterSignUpUrl="/"
          signInUrl="#"
        />
      )}

      {/* ── Mode toggle (below the Clerk card) ──────────────────────────────── */}
      <p style={{ marginTop: 20, fontSize: 13, color: "#777777" }}>
        {mode === "signIn" ? "Don't have an account? " : "Already have an account? "}
        <button
          onClick={() => setMode(mode === "signIn" ? "signUp" : "signIn")}
          style={{
            background: "none",
            border:     "none",
            color:      "#00FF41",
            fontWeight: 600,
            fontSize:   13,
            cursor:     "pointer",
            padding:    0,
          }}
        >
          {mode === "signIn" ? "Sign Up" : "Sign In"}
        </button>
      </p>

      {/* ── Fine print ───────────────────────────────────────────────────────── */}
      <p style={{ marginTop: 24, fontSize: 10, color: "#444444", textAlign: "center", maxWidth: 280 }}>
        Trading carries significant risk. Past performance does not guarantee future results.
        Use practice accounts only.
      </p>
    </div>
  );
}