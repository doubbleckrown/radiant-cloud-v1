/**
 * ProfilePage — Interactive user settings
 *
 * Every field can be edited inline — no navigation away, no modals.
 * Tap the pencil icon → field opens in edit mode → confirm with ✓ or cancel with ✗.
 *
 * Editable fields:
 *   • Display Name       → PATCH /api/account/settings  { display_name }
 *   • Risk % Per Trade   → PATCH /api/account/settings  { risk_pct }     (slider 0.1–10 %)
 *   • Oanda API Key Hint → PATCH /api/account/settings  { oanda_key_hint } (last 4 chars)
 *
 * Read-only / navigational:
 *   • Auto-Trade status  → links conceptually to Account tab
 *   • Security           → placeholder (password change out of scope)
 *   • App Info           → static version string
 *
 * Design tokens used:
 *   .active-scale        — native mobile press feel on every tappable element
 *   .border-glow-green   — glowing border on the actively edited field
 *   radiant-500 (#00FF41) — brand green
 *   void-*               — OLED-safe blacks
 */

import { useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAuthStore } from "../store/authStore";

// ── EditIcon / CheckIcon / XIcon ─────────────────────────────────────────────
const PencilIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
);
const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);
const XIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);
const ChevronRight = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="#333" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6"/>
  </svg>
);

// ── Main component ────────────────────────────────────────────────────────────
export default function ProfilePage() {
  const { user, logout, updateSettings, fetchMe } = useAuthStore();

  // Which field is currently open for editing: null | "name" | "risk" | "key"
  const [editing, setEditing] = useState(null);

  // Per-field draft values
  const [draftName, setDraftName] = useState("");
  const [draftRisk, setDraftRisk] = useState(1.0);
  const [draftKey,  setDraftKey]  = useState("");

  // Per-field saving state
  const [saving, setSaving] = useState(null);  // null | "name" | "risk" | "key"
  const [saveError, setSaveError] = useState(null);

  // ── Open an edit field ──────────────────────────────────────────────────────
  const openEdit = useCallback((field) => {
    setSaveError(null);
    if (field === "name") setDraftName(user?.name ?? "");
    if (field === "risk") setDraftRisk(user?.risk_pct ?? 1.0);
    if (field === "key")  setDraftKey(user?.oanda_key_hint ?? "");
    setEditing(field);
  }, [user]);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setSaveError(null);
  }, []);

  // ── Commit a field ──────────────────────────────────────────────────────────
  const commit = useCallback(async (field) => {
    setSaving(field);
    setSaveError(null);
    try {
      const patch =
        field === "name" ? { display_name: draftName.trim() }  :
        field === "risk" ? { risk_pct:     parseFloat(draftRisk) } :
        field === "key"  ? { oanda_key_hint: draftKey.trim() }  : {};

      if (!Object.keys(patch).length) return;
      await updateSettings(patch);
      setEditing(null);
    } catch (err) {
      setSaveError(err?.response?.data?.detail ?? "Save failed — try again");
    } finally {
      setSaving(null);
    }
  }, [draftName, draftRisk, draftKey, updateSettings]);

  const isAutoOn = user?.auto_trade_active ?? false;

  return (
    <div className="flex flex-col h-full" style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* ── Sticky header ─────────────────────────────────────────────────── */}
      <div
        className="flex-shrink-0 sticky top-0 z-20 px-4 pt-4 pb-3"
        style={{
          background:     "rgba(5,5,5,0.97)",
          backdropFilter: "blur(20px)",
          borderBottom:   "1px solid rgba(0,255,65,0.06)",
        }}
      >
        <h1 className="text-xl font-display text-white tracking-wide">Profile</h1>
      </div>

      {/* ── Scrollable body ───────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-6 space-y-5">

        {/* ── Avatar + name block ─────────────────────────────────────────── */}
        <div className="flex flex-col items-center gap-3">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 320, damping: 26 }}
            className="w-20 h-20 rounded-3xl flex items-center justify-center text-3xl font-display relative select-none"
            style={{
              background: "rgba(0,255,65,0.08)",
              border:     "1px solid rgba(0,255,65,0.2)",
              boxShadow:  "0 0 32px rgba(0,255,65,0.12)",
              color:      "#00FF41",
            }}
          >
            {(user?.name ?? "?").charAt(0).toUpperCase()}
            {/* Online badge */}
            <div
              className="absolute -bottom-1 -right-1 w-5 h-5 rounded-lg flex items-center justify-center"
              style={{ background: "#00FF41", boxShadow: "0 0 8px rgba(0,255,65,0.7)" }}
            >
              <span style={{ fontSize: 10, color: "#000", fontWeight: 700 }}>✓</span>
            </div>
          </motion.div>

          <div className="text-center">
            <p className="text-white text-xl font-display tracking-wide">
              {user?.name ?? "Trader"}
            </p>
            <p style={{ color: "#aaaaaa", fontSize: "0.875rem", marginTop: 2 }}>{user?.email}</p>
          </div>
        </div>

        {/* ── Error banner ─────────────────────────────────────────────────── */}
        <AnimatePresence>
          {saveError && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="rounded-xl px-4 py-3 text-sm font-display tracking-wide"
              style={{ background: "rgba(255,58,58,0.08)", border: "1px solid rgba(255,58,58,0.2)", color: "#FF3A3A" }}
            >
              ⚠ {saveError}
            </motion.div>
          )}
        </AnimatePresence>

        {/* ══════════════════════════════════════════════════════════════════
            SECTION 1 — User Settings
        ══════════════════════════════════════════════════════════════════ */}
        <Section label="User Settings">

          {/* Display Name */}
          <EditableRow
            icon="👤"
            label="Display Name"
            value={user?.name ?? "—"}
            isEditing={editing === "name"}
            isSaving={saving === "name"}
            onEdit={() => openEdit("name")}
            onCancel={cancelEdit}
            onSave={() => commit("name")}
          >
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") commit("name"); if (e.key === "Escape") cancelEdit(); }}
              placeholder="Your display name"
              maxLength={40}
              className="w-full bg-transparent outline-none text-white text-sm font-body placeholder-void-600"
              style={{ caretColor: "#00FF41" }}
            />
          </EditableRow>

          {/* Email — read-only */}
          <StaticRow icon="📧" label="Email" value={user?.email ?? "—"} />

        </Section>

        {/* ══════════════════════════════════════════════════════════════════
            SECTION 2 — Risk Configuration
        ══════════════════════════════════════════════════════════════════ */}
        <Section label="Risk Configuration">

          {/* Risk % per trade */}
          <EditableRow
            icon="📊"
            label="Risk % Per Trade"
            value={`${(user?.risk_pct ?? 1.0).toFixed(1)}%`}
            isEditing={editing === "risk"}
            isSaving={saving === "risk"}
            onEdit={() => openEdit("risk")}
            onCancel={cancelEdit}
            onSave={() => commit("risk")}
            valueSub={riskLabel(user?.risk_pct ?? 1.0)}
          >
            <RiskSlider value={draftRisk} onChange={setDraftRisk} />
          </EditableRow>

          {/* RR Ratio — read-only (enforced by backend) */}
          <StaticRow
            icon="⚖️"
            label="Risk / Reward Ratio"
            value="1 : 3"
            sub="Fixed by SMC engine — TP is always 3× risk"
          />

        </Section>

        {/* ══════════════════════════════════════════════════════════════════
            SECTION 3 — API Management
        ══════════════════════════════════════════════════════════════════ */}
        <Section label="API Management">

          {/* Oanda Key Hint */}
          <EditableRow
            icon="🔑"
            label="Oanda API Key"
            value={user?.oanda_key_hint ? `•••• ${user.oanda_key_hint}` : "Not set"}
            isEditing={editing === "key"}
            isSaving={saving === "key"}
            onEdit={() => openEdit("key")}
            onCancel={cancelEdit}
            onSave={() => commit("key")}
            valueSub="Last 4 characters stored only"
          >
            <div className="space-y-2">
              <input
                autoFocus
                value={draftKey}
                onChange={(e) => setDraftKey(e.target.value.slice(-4))}
                onKeyDown={(e) => { if (e.key === "Enter") commit("key"); if (e.key === "Escape") cancelEdit(); }}
                placeholder="Enter last 4 chars of key"
                maxLength={4}
                className="w-full bg-transparent outline-none text-white text-sm font-mono placeholder-void-600 tracking-widest"
                style={{ caretColor: "#00FF41", fontFamily: "'JetBrains Mono', monospace" }}
              />
              <p style={{ color: "#aaaaaa", fontSize: "0.625rem", letterSpacing: "0.05em" }}>
                For security, only the last 4 characters are stored here. Configure the full
                key in your .env file on the server.
              </p>
            </div>
          </EditableRow>

          {/* Oanda Server — read-only */}
          <StaticRow
            icon="🌐"
            label="Oanda Server"
            value="Practice"
            sub="api-fxpractice.oanda.com"
          />

        </Section>

        {/* ══════════════════════════════════════════════════════════════════
            SECTION 4 — Auto-Trade Status (informational — toggle is in Account tab)
        ══════════════════════════════════════════════════════════════════ */}
        <Section label="Auto-Trade">
          <div
            className="flex items-center gap-3 p-4 rounded-2xl"
            style={{
              background: isAutoOn ? "rgba(0,255,65,0.05)" : "#0f0f0f",
              border: `1px solid ${isAutoOn ? "rgba(0,255,65,0.2)" : "rgba(255,255,255,0.05)"}`,
            }}
          >
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center text-lg flex-shrink-0"
              style={{
                background: isAutoOn ? "rgba(0,255,65,0.1)" : "rgba(255,255,255,0.04)",
                border: `1px solid ${isAutoOn ? "rgba(0,255,65,0.2)" : "rgba(255,255,255,0.06)"}`,
              }}
            >
              {isAutoOn ? "⚡" : "🤖"}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-white text-sm font-body">Master Auto-Trade</div>
              <div
                className="text-xs mt-0.5 font-display tracking-wide"
                style={{ color: isAutoOn ? "#00FF41" : "#555" }}
              >
                {isAutoOn ? "ACTIVE — live orders enabled" : "OFF — signals monitored only"}
              </div>
            </div>
            {/* Status pill */}
            <span
              className="px-2 py-1 rounded-lg text-[10px] font-display tracking-widest uppercase flex-shrink-0"
              style={{
                background: isAutoOn ? "rgba(0,255,65,0.12)" : "rgba(255,255,255,0.04)",
                border: `1px solid ${isAutoOn ? "rgba(0,255,65,0.3)" : "rgba(255,255,255,0.08)"}`,
                color: isAutoOn ? "#00FF41" : "#444",
              }}
            >
              {isAutoOn ? "ON" : "OFF"}
            </span>
          </div>
          <p style={{ color: "#777777", fontSize: "0.75rem", padding: "0 4px", letterSpacing: "0.04em" }}>
            Toggle auto-trade from the Account → Summary tab.
          </p>
        </Section>

        {/* ══════════════════════════════════════════════════════════════════
            SECTION 5 — Security  (static for now)
        ══════════════════════════════════════════════════════════════════ */}
        <Section label="Security">
          <StaticRow
            icon="🔒"
            label="Password"
            value="••••••••"
            sub="Change via the web portal"
            tappable
            onTap={() => {}}
          />
          <StaticRow
            icon="📱"
            label="Session"
            value="Active"
            sub={`Token expires in ${ACCESS_EXPIRE_MINUTES_DISPLAY}`}
          />
        </Section>

        {/* ══════════════════════════════════════════════════════════════════
            SECTION 6 — About
        ══════════════════════════════════════════════════════════════════ */}
        <Section label="About">
          <StaticRow icon="🧠" label="SMC Engine"    value="v1.0.0"      sub="3-layer confluence analysis" />
          <StaticRow icon="📈" label="Instruments"   value="20"          sub="Forex · Metals · Indices" />
          <StaticRow icon="⏱"  label="Signal TTL"    value="2 hours"     sub="Auto-expires if TP/SL not hit" />
          <StaticRow icon="🔄" label="Candle Refresh" value="60 s"       sub="H1 · M15 · M5 per instrument" />
        </Section>

        {/* ── Sign Out ──────────────────────────────────────────────────────── */}
        <motion.button
          whileTap={{ scale: 0.96 }}
          onClick={logout}
          className="active-scale w-full py-4 rounded-2xl font-display tracking-widest uppercase text-sm"
          style={{
            background: "transparent",
            border:     "1px solid rgba(255,58,58,0.2)",
            color:      "#FF3A3A",
          }}
        >
          Sign Out
        </motion.button>

        {/* Safe area bottom padding */}
        <div style={{ height: "env(safe-area-inset-bottom, 16px)" }} />
      </div>
    </div>
  );
}

// ── Placeholder: real value comes from backend token config ─────────────────
const ACCESS_EXPIRE_MINUTES_DISPLAY = "60 min";

// ─────────────────────────────────────────────────────────────────────────────
//  Section wrapper
// ─────────────────────────────────────────────────────────────────────────────
function Section({ label, children }) {
  return (
    <div>
      <div style={{ color: "#aaaaaa", fontSize: "0.625rem", letterSpacing: "0.12em", textTransform: "uppercase", padding: "0 4px", marginBottom: 8 }}>
        {label}
      </div>
      <div
        className="rounded-2xl overflow-hidden divide-y"
        style={{ background: "#0f0f0f", borderColor: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.05)" }}
      >
        {children}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  EditableRow — row that has a pencil icon and an inline edit area
// ─────────────────────────────────────────────────────────────────────────────
function EditableRow({
  icon, label, value, valueSub,
  isEditing, isSaving,
  onEdit, onCancel, onSave,
  children,
}) {
  return (
    <motion.div
      layout
      className={`p-4 ${isEditing ? "border-glow-green" : ""}`}
      style={{
        background:    isEditing ? "rgba(0,255,65,0.03)" : "transparent",
        borderRadius:  0,
        position:      "relative",
      }}
    >
      {/* ── Display row ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center text-base flex-shrink-0"
          style={{
            background: isEditing ? "rgba(0,255,65,0.1)" : "rgba(255,255,255,0.04)",
            border:     `1px solid ${isEditing ? "rgba(0,255,65,0.2)" : "rgba(255,255,255,0.06)"}`,
          }}
        >
          {icon}
        </div>

        <div className="flex-1 min-w-0">
          <div style={{ color: "#aaaaaa", fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
          {!isEditing && (
            <div className="text-white text-sm font-body mt-0.5 truncate">{value}</div>
          )}
          {!isEditing && valueSub && (
            <div style={{ color: "#777777", fontSize: "0.625rem", marginTop: 2 }}>{valueSub}</div>
          )}
        </div>

        {/* ── Action buttons ─────────────────────────────────────────────── */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {!isEditing && (
            <button
              onClick={onEdit}
              className="active-scale w-8 h-8 flex items-center justify-center rounded-xl transition-colors"
              style={{
                background: "rgba(255,255,255,0.04)",
                border:     "1px solid rgba(255,255,255,0.07)",
                color:      "#555",
              }}
              aria-label={`Edit ${label}`}
            >
              <PencilIcon />
            </button>
          )}

          {isEditing && (
            <>
              {/* Cancel */}
              <button
                onClick={onCancel}
                disabled={isSaving}
                className="active-scale w-8 h-8 flex items-center justify-center rounded-xl"
                style={{
                  background: "rgba(255,58,58,0.1)",
                  border:     "1px solid rgba(255,58,58,0.2)",
                  color:      "#FF3A3A",
                  opacity:    isSaving ? 0.5 : 1,
                }}
                aria-label="Cancel"
              >
                <XIcon />
              </button>

              {/* Save */}
              <button
                onClick={onSave}
                disabled={isSaving}
                className="active-scale w-8 h-8 flex items-center justify-center rounded-xl"
                style={{
                  background: "rgba(0,255,65,0.12)",
                  border:     "1px solid rgba(0,255,65,0.3)",
                  color:      "#00FF41",
                  opacity:    isSaving ? 0.6 : 1,
                }}
                aria-label="Save"
              >
                {isSaving ? (
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 0.6, repeat: Infinity, ease: "linear" }}
                    className="w-3.5 h-3.5 rounded-full border border-transparent"
                    style={{ borderTopColor: "#00FF41" }}
                  />
                ) : (
                  <CheckIcon />
                )}
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Inline edit area (animated expand) ──────────────────────────── */}
      <AnimatePresence>
        {isEditing && (
          <motion.div
            initial={{ opacity: 0, height: 0, marginTop: 0 }}
            animate={{ opacity: 1, height: "auto", marginTop: 12 }}
            exit={{ opacity: 0, height: 0, marginTop: 0 }}
            className="overflow-hidden"
          >
            <div
              className="px-3 py-2.5 rounded-xl"
              style={{
                background: "rgba(0,0,0,0.5)",
                border:     "1px solid rgba(0,255,65,0.2)",
              }}
            >
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  StaticRow — display-only row (optionally tappable)
// ─────────────────────────────────────────────────────────────────────────────
function StaticRow({ icon, label, value, sub, tappable = false, onTap }) {
  const inner = (
    <>
      <div
        className="w-9 h-9 rounded-xl flex items-center justify-center text-base flex-shrink-0"
        style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div style={{ color: "#aaaaaa", fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
        <div className="text-white text-sm font-body mt-0.5 truncate">{value}</div>
        {sub && <div style={{ color: "#777777", fontSize: "0.625rem", marginTop: 2 }}>{sub}</div>}
      </div>
      {tappable && <ChevronRight />}
    </>
  );

  if (tappable) {
    return (
      <button
        onClick={onTap}
        className="active-scale w-full flex items-center gap-3 p-4 text-left"
        style={{ background: "transparent", border: "none" }}
      >
        {inner}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3 p-4">
      {inner}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  RiskSlider — range input styled to match the dark theme
// ─────────────────────────────────────────────────────────────────────────────
function RiskSlider({ value, onChange }) {
  const pct  = ((value - 0.1) / (10.0 - 0.1)) * 100;
  const color = value <= 2.0 ? "#00FF41" : value <= 5.0 ? "#FFB800" : "#FF3A3A";
  const tier  = value <= 1.0 ? "Conservative" : value <= 2.0 ? "Standard" : value <= 4.0 ? "Aggressive" : "High Risk";

  return (
    <div className="space-y-3">
      {/* Value display */}
      <div className="flex items-baseline justify-between">
        <span
          className="font-mono text-2xl font-bold"
          style={{ color, fontFamily: "'JetBrains Mono', monospace", textShadow: `0 0 10px ${color}60` }}
        >
          {parseFloat(value).toFixed(1)}%
        </span>
        <span
          className="text-xs font-display tracking-wider px-2 py-1 rounded-lg"
          style={{
            background: `${color}12`,
            border:     `1px solid ${color}30`,
            color,
          }}
        >
          {tier}
        </span>
      </div>

      {/* Slider track */}
      <div className="relative">
        {/* Filled track */}
        <div
          className="absolute top-1/2 left-0 h-1.5 rounded-full pointer-events-none"
          style={{
            width:      `${pct}%`,
            transform:  "translateY(-50%)",
            background: `linear-gradient(90deg, #00FF41, ${color})`,
            boxShadow:  `0 0 6px ${color}60`,
            transition: "width 0.05s, background 0.2s",
          }}
        />
        <input
          type="range"
          min="0.1"
          max="10.0"
          step="0.1"
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="w-full relative z-10"
          style={{
            WebkitAppearance: "none",
            appearance:        "none",
            height:            "6px",
            borderRadius:      "3px",
            background:        "rgba(255,255,255,0.06)",
            cursor:            "pointer",
            outline:           "none",
          }}
        />
      </div>

      {/* Tick labels */}
      <div className="flex justify-between" style={{ fontSize: "0.625rem", color: "#777777" }}>
        <span>0.1%</span>
        <span>2.5%</span>
        <span>5%</span>
        <span>7.5%</span>
        <span>10%</span>
      </div>

      {/* Risk description */}
      <div
        className="px-3 py-2 rounded-xl text-[11px] font-display tracking-wide"
        style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.05)", color: "#666" }}
      >
        Each trade risks {parseFloat(value).toFixed(1)}% of your account balance.
        At $10,000 that's ${(10000 * value / 100).toFixed(0)} per trade.
      </div>
    </div>
  );
}

// ── Slider thumb styles injected once ────────────────────────────────────────
// (webkit / moz thumb styling can't be done in Tailwind, so we inject it)
if (typeof document !== "undefined" && !document.getElementById("risk-slider-style")) {
  const style = document.createElement("style");
  style.id    = "risk-slider-style";
  style.textContent = `
    input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width:        20px;
      height:       20px;
      border-radius:50%;
      background:   #00FF41;
      box-shadow:   0 0 8px rgba(0,255,65,0.7);
      cursor:       pointer;
      border:       2px solid #000;
      transition:   box-shadow 0.15s;
    }
    input[type="range"]::-webkit-slider-thumb:active {
      box-shadow: 0 0 16px rgba(0,255,65,1);
    }
    input[type="range"]::-moz-range-thumb {
      width:        20px;
      height:       20px;
      border-radius:50%;
      background:   #00FF41;
      box-shadow:   0 0 8px rgba(0,255,65,0.7);
      cursor:       pointer;
      border:       2px solid #000;
    }
  `;
  document.head.appendChild(style);
}

// ── Risk label helper ─────────────────────────────────────────────────────────
function riskLabel(pct) {
  if (pct <= 1.0) return "Conservative";
  if (pct <= 2.0) return "Standard";
  if (pct <= 4.0) return "Aggressive";
  return "High Risk";
}