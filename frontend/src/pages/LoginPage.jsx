import { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAuthStore } from "../store/authStore";

export default function LoginPage() {
  const [mode, setMode]         = useState("login"); // "login" | "signup"
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [name, setName]         = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState("");
  const [focused, setFocused]   = useState(null);

  const { login, signup } = useAuthStore();

  const handleSubmit = async () => {
    setError("");
    if (!email || !password) { setError("Please fill all fields."); return; }
    if (mode === "signup" && !name) { setError("Name is required."); return; }

    setLoading(true);
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        await signup(email, password, name);
      }
    } catch (e) {
      setError(e.message || "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="relative min-h-screen bg-void flex flex-col items-center justify-center px-6 overflow-hidden"
      style={{ fontFamily: "'DM Sans', sans-serif" }}
    >
      {/* Background grid */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `
            linear-gradient(rgba(0,255,65,0.5) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0,255,65,0.5) 1px, transparent 1px)
          `,
          backgroundSize: "40px 40px",
        }}
      />

      {/* Radial glow at center */}
      <div
        className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 pointer-events-none"
        style={{
          background: "radial-gradient(circle, rgba(0,255,65,0.06) 0%, transparent 70%)",
        }}
      />

      {/* Logo lockup */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.32, 0.72, 0, 1] }}
        className="mb-10 text-center z-10"
      >
        {/* Logo mark */}
        <div className="flex items-center justify-center mb-4">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center relative"
            style={{
              background: "rgba(0,255,65,0.08)",
              border: "1px solid rgba(0,255,65,0.25)",
              boxShadow: "0 0 32px rgba(0,255,65,0.2), inset 0 0 16px rgba(0,255,65,0.05)",
            }}
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <polyline
                points="3 17 8.5 10.5 13.5 15.5 22 7"
                stroke="#00FF41" strokeWidth="2.2" strokeLinecap="round"
                style={{ filter: "drop-shadow(0 0 4px rgba(0,255,65,0.8))" }}
              />
              <polyline
                points="16 7 22 7 22 13"
                stroke="#00FF41" strokeWidth="2.2" strokeLinecap="round"
              />
            </svg>
          </div>
        </div>

        <h1
          className="text-3xl font-display tracking-[0.15em] uppercase"
          style={{
            color: "#00FF41",
            textShadow: "0 0 20px rgba(0,255,65,0.6), 0 0 40px rgba(0,255,65,0.2)",
          }}
        >
          FX RADIANT
        </h1>
        <p className="text-void-800 text-sm mt-1 font-body tracking-wide">
          Smart Money · Institutional Edge
        </p>
      </motion.div>

      {/* Card */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.15, ease: [0.32, 0.72, 0, 1] }}
        className="w-full max-w-sm z-10"
        style={{
          background: "rgba(15,15,15,0.9)",
          border: "1px solid rgba(0,255,65,0.1)",
          borderRadius: "1.5rem",
          boxShadow: "0 24px 64px rgba(0,0,0,0.8), inset 0 1px 0 rgba(0,255,65,0.05)",
        }}
      >
        {/* Mode toggle */}
        <div className="flex p-1.5 m-5 rounded-xl" style={{ background: "#0f0f0f", border: "1px solid #1a1a1a" }}>
          {["login", "signup"].map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setError(""); }}
              className="relative flex-1 py-2.5 text-sm font-display tracking-wider uppercase transition-colors"
              style={{ color: mode === m ? "#050505" : "#404040" }}
            >
              {mode === m && (
                <motion.div
                  layoutId="mode-pill"
                  className="absolute inset-0 rounded-lg"
                  style={{
                    background: "#00FF41",
                    boxShadow: "0 0 16px rgba(0,255,65,0.4)",
                  }}
                  transition={{ type: "spring", stiffness: 400, damping: 30 }}
                />
              )}
              <span className="relative z-10">{m === "login" ? "Sign In" : "Sign Up"}</span>
            </button>
          ))}
        </div>

        {/* Fields */}
        <div className="px-5 pb-5 space-y-3">
          <AnimatePresence>
            {mode === "signup" && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.25 }}
              >
                <InputField
                  label="Full Name"
                  type="text"
                  value={name}
                  onChange={setName}
                  placeholder="John Smith"
                  icon={<UserIcon />}
                  focused={focused === "name"}
                  onFocus={() => setFocused("name")}
                  onBlur={() => setFocused(null)}
                />
              </motion.div>
            )}
          </AnimatePresence>

          <InputField
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="trader@example.com"
            icon={<EmailIcon />}
            focused={focused === "email"}
            onFocus={() => setFocused("email")}
            onBlur={() => setFocused(null)}
          />

          <InputField
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="••••••••"
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
                className="text-bear text-xs px-1"
              >
                {error}
              </motion.p>
            )}
          </AnimatePresence>

          {/* Submit button */}
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={handleSubmit}
            disabled={loading}
            className="w-full py-4 rounded-xl font-display tracking-widest uppercase text-sm relative overflow-hidden"
            style={{
              background: loading ? "rgba(0,255,65,0.4)" : "#00FF41",
              color: "#050505",
              boxShadow: loading ? "none" : "0 0 24px rgba(0,255,65,0.5), 0 0 48px rgba(0,255,65,0.2)",
              transition: "all 0.2s",
            }}
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <SpinnerIcon />
                Authenticating...
              </span>
            ) : (
              mode === "login" ? "Enter Platform" : "Create Account"
            )}
          </motion.button>

          {/* Footer */}
          <p className="text-void-700 text-xs text-center pt-2">
            Secured by JWT · 256-bit encryption
          </p>
        </div>
      </motion.div>

      {/* Bottom disclaimer */}
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8 }}
        className="text-void-600 text-xs text-center mt-8 px-8 z-10"
      >
        Trading CFDs carries significant risk. Past performance is not indicative of future results.
      </motion.p>
    </div>
  );
}

// ── Input Field Component ─────────────────────────────────────────────────────

function InputField({ label, type, value, onChange, placeholder, icon, focused, onFocus, onBlur, onEnter }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-display tracking-wider uppercase text-void-800 px-1">
        {label}
      </label>
      <div
        className="flex items-center gap-3 px-4 py-3.5 rounded-xl transition-all duration-200"
        style={{
          background: "#1a1a1a",
          border: `1px solid ${focused ? "rgba(0,255,65,0.4)" : "rgba(255,255,255,0.06)"}`,
          boxShadow: focused ? "0 0 0 3px rgba(0,255,65,0.06)" : "none",
        }}
      >
        <div style={{ color: focused ? "#00FF41" : "#4d4d4d", transition: "color 0.2s" }}>
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
          className="flex-1 bg-transparent outline-none text-sm text-white placeholder-void-600"
          style={{ fontFamily: "'DM Sans', sans-serif" }}
        />
      </div>
    </div>
  );
}

// ── Micro Icons ───────────────────────────────────────────────────────────────
function UserIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="7" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/></svg>;
}
function EmailIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="2,4 12,13 22,4"/></svg>;
}
function LockIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>;
}
function SpinnerIcon() {
  return (
    <motion.svg
      width="14" height="14" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2.5"
      animate={{ rotate: 360 }}
      transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
    >
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
    </motion.svg>
  );
}