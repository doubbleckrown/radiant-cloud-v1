import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAuthStore } from "../store/authStore";

// All text colours are explicit inline styles — never Tailwind void-* classes.
// Tailwind custom palette values are unreliable on Vercel cached builds.
const TEXT = {
  label:    "#aaaaaa",   // field labels, muted subtitles  (≈5:1 on #1a1a1a)
  sublabel: "#777777",   // fine print / disclaimer
  white:    "#ffffff",
  green:    "#00FF41",
  red:      "#FF3A3A",
};

export default function LoginPage() {
  const [mode,     setMode]     = useState("login");
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [name,     setName]     = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");
  const [focused,  setFocused]  = useState(null);

  const { login, signup } = useAuthStore();

  const handleSubmit = async () => {
    setError("");
    if (!email || !password)          { setError("Please fill all fields."); return; }
    if (mode === "signup" && !name)   { setError("Name is required.");       return; }
    setLoading(true);
    try {
      mode === "login" ? await login(email, password) : await signup(email, password, name);
    } catch (e) {
      setError(e.userMessage || e.message || "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        fontFamily: "'DM Sans', sans-serif",
        minHeight: "100vh",
        background: "#050505",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Background grid */}
      <div style={{
        position: "absolute", inset: 0, opacity: 0.03, pointerEvents: "none",
        backgroundImage: `linear-gradient(rgba(0,255,65,0.5) 1px, transparent 1px),
                          linear-gradient(90deg, rgba(0,255,65,0.5) 1px, transparent 1px)`,
        backgroundSize: "40px 40px",
      }} />

      {/* Centre glow */}
      <div style={{
        position: "absolute", top: "33%", left: "50%",
        transform: "translate(-50%, -50%)",
        width: 384, height: 384, pointerEvents: "none",
        background: "radial-gradient(circle, rgba(0,255,65,0.06) 0%, transparent 70%)",
      }} />

      {/* Logo */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.32, 0.72, 0, 1] }}
        style={{ marginBottom: 40, textAlign: "center", position: "relative", zIndex: 1 }}
      >
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 16,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,255,65,0.08)",
            border: "1px solid rgba(0,255,65,0.25)",
            boxShadow: "0 0 32px rgba(0,255,65,0.2), inset 0 0 16px rgba(0,255,65,0.05)",
          }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <polyline points="3 17 8.5 10.5 13.5 15.5 22 7"
                stroke="#00FF41" strokeWidth="2.2" strokeLinecap="round"
                style={{ filter: "drop-shadow(0 0 4px rgba(0,255,65,0.8))" }} />
              <polyline points="16 7 22 7 22 13"
                stroke="#00FF41" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </div>
        </div>

        <h1 style={{
          fontSize: "1.875rem", fontWeight: 700,
          letterSpacing: "0.15em", textTransform: "uppercase",
          color: TEXT.green,
          textShadow: "0 0 20px rgba(0,255,65,0.6), 0 0 40px rgba(0,255,65,0.2)",
          margin: 0,
        }}>
          FX RADIANT
        </h1>
        {/* ← was void-800: now explicit #aaaaaa */}
        <p style={{ color: TEXT.label, fontSize: "0.875rem", marginTop: 4, letterSpacing: "0.04em" }}>
          Smart Money · Institutional Edge
        </p>
      </motion.div>

      {/* Card */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.15, ease: [0.32, 0.72, 0, 1] }}
        style={{
          width: "100%", maxWidth: 384, position: "relative", zIndex: 1,
          background: "rgba(15,15,15,0.9)",
          border: "1px solid rgba(0,255,65,0.1)",
          borderRadius: 24,
          boxShadow: "0 24px 64px rgba(0,0,0,0.8), inset 0 1px 0 rgba(0,255,65,0.05)",
        }}
      >
        {/* Mode toggle */}
        <div style={{ display: "flex", padding: 6, margin: 20, borderRadius: 12, background: "#0f0f0f", border: "1px solid #1a1a1a" }}>
          {["login", "signup"].map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setError(""); }}
              style={{
                flex: 1, padding: "10px 0",
                fontSize: "0.8rem", fontWeight: 700,
                letterSpacing: "0.1em", textTransform: "uppercase",
                border: "none", borderRadius: 8, cursor: "pointer",
                position: "relative",
                color: mode === m ? "#050505" : TEXT.label,
                background: "transparent",
                transition: "color 0.2s",
              }}
            >
              {mode === m && (
                <motion.div
                  layoutId="mode-pill"
                  style={{
                    position: "absolute", inset: 0, borderRadius: 8,
                    background: TEXT.green,
                    boxShadow: "0 0 16px rgba(0,255,65,0.4)",
                  }}
                  transition={{ type: "spring", stiffness: 400, damping: 30 }}
                />
              )}
              <span style={{ position: "relative", zIndex: 1 }}>
                {m === "login" ? "Sign In" : "Sign Up"}
              </span>
            </button>
          ))}
        </div>

        {/* Fields */}
        <div style={{ padding: "0 20px 20px", display: "flex", flexDirection: "column", gap: 12 }}>

          <AnimatePresence>
            {mode === "signup" && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.25 }}
                style={{ overflow: "hidden" }}
              >
                <InputField
                  label="Full Name" type="text" value={name}
                  onChange={setName} placeholder="John Smith"
                  icon={<UserIcon />}
                  focused={focused === "name"}
                  onFocus={() => setFocused("name")}
                  onBlur={() => setFocused(null)}
                />
              </motion.div>
            )}
          </AnimatePresence>

          <InputField
            label="Email" type="email" value={email}
            onChange={setEmail} placeholder="trader@example.com"
            icon={<EmailIcon />}
            focused={focused === "email"}
            onFocus={() => setFocused("email")}
            onBlur={() => setFocused(null)}
          />

          <InputField
            label="Password" type="password" value={password}
            onChange={setPassword} placeholder="••••••••"
            icon={<LockIcon />}
            focused={focused === "pass"}
            onFocus={() => setFocused("pass")}
            onBlur={() => setFocused(null)}
            onEnter={handleSubmit}
          />

          {/* Error */}
          <AnimatePresence>
            {error && (
              <motion.p
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                style={{ color: TEXT.red, fontSize: "0.78rem", margin: 0 }}
              >
                {error}
              </motion.p>
            )}
          </AnimatePresence>

          {/* Submit */}
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={handleSubmit}
            disabled={loading}
            style={{
              width: "100%", padding: "16px 0", borderRadius: 12, border: "none",
              fontWeight: 700, fontSize: "0.85rem", letterSpacing: "0.12em",
              textTransform: "uppercase", cursor: loading ? "not-allowed" : "pointer",
              background: loading ? "rgba(0,255,65,0.4)" : TEXT.green,
              color: "#050505",
              boxShadow: loading ? "none" : "0 0 24px rgba(0,255,65,0.5), 0 0 48px rgba(0,255,65,0.2)",
              transition: "all 0.2s",
            }}
          >
            {loading ? (
              <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <SpinnerIcon /> Authenticating...
              </span>
            ) : (
              mode === "login" ? "Enter Platform" : "Create Account"
            )}
          </motion.button>

          {/* Footer — was void-700: now explicit */}
          <p style={{ color: TEXT.label, fontSize: "0.72rem", textAlign: "center", margin: "4px 0 0" }}>
            Secured by JWT · 256-bit encryption
          </p>
        </div>
      </motion.div>

      {/* Disclaimer — was void-600: now explicit */}
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8 }}
        style={{
          color: TEXT.sublabel, fontSize: "0.7rem", textAlign: "center",
          marginTop: 32, padding: "0 32px",
          position: "relative", zIndex: 1,
          lineHeight: 1.5,
        }}
      >
        Trading CFDs carries significant risk. Past performance is not indicative of future results.
      </motion.p>
    </div>
  );
}

// ── Input Field ───────────────────────────────────────────────────────────────
function InputField({ label, type, value, onChange, placeholder, icon, focused, onFocus, onBlur, onEnter }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {/* label — was void-800: now explicit #aaaaaa */}
      <label style={{
        color: "#aaaaaa", fontSize: "0.68rem", fontWeight: 700,
        letterSpacing: "0.1em", textTransform: "uppercase", paddingLeft: 2,
      }}>
        {label}
      </label>
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "12px 16px", borderRadius: 12,
        background: "#1a1a1a",
        border: `1px solid ${focused ? "rgba(0,255,65,0.4)" : "rgba(255,255,255,0.06)"}`,
        boxShadow: focused ? "0 0 0 3px rgba(0,255,65,0.06)" : "none",
        transition: "border-color 0.2s, box-shadow 0.2s",
      }}>
        <div style={{ color: focused ? "#00FF41" : "#555", transition: "color 0.2s", flexShrink: 0 }}>
          {icon}
        </div>
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          onFocus={onFocus}
          onBlur={onBlur}
          onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
          style={{
            flex: 1, background: "transparent", border: "none", outline: "none",
            fontSize: "0.9rem",
            color: "#ffffff",           // typed text: always white
            fontFamily: "'DM Sans', sans-serif",
          }}
        />
      </div>
    </div>
  );
}

function UserIcon()  { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="7" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/></svg>; }
function EmailIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="2,4 12,13 22,4"/></svg>; }
function LockIcon()  { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>; }
function SpinnerIcon() {
  return (
    <motion.svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      animate={{ rotate: 360 }} transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}>
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
    </motion.svg>
  );
}