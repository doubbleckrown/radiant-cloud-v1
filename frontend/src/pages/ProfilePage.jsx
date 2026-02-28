/**
 * ProfilePage
 * ══════════════════════════════════════════════════════════════
 * Inline-edit settings page — full AccountPage design parity.
 * Font: Inter (UI)  ·  JetBrains Mono (numbers)
 * All text uses explicit inline colors — never Tailwind purge-risk classes.
 */
import { useState, useCallback } from "react";
import { motion, AnimatePresence }   from "framer-motion";
import { useAuthStore }              from "../store/authStore";
import { useUser, useClerk }         from "@clerk/clerk-react";

// ── Design tokens — identical to AccountPage ──────────────────────────────────
const C = {
  green:    "#00FF41",
  greenDim: "rgba(0,255,65,0.12)",
  greenBdr: "rgba(0,255,65,0.25)",
  red:      "#FF3A3A",
  amber:    "#FFB800",
  white:    "#ffffff",
  label:    "#aaaaaa",
  sub:      "#666666",
  card:     "#0f0f0f",
  cardBdr:  "rgba(255,255,255,0.07)",
  sheet:    "#141414",
};

const FONT_UI   = "'Inter', sans-serif";
const FONT_MONO = "'JetBrains Mono', monospace";

// ── Inline SVG icons ──────────────────────────────────────────────────────────
const PencilIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
);
const CheckIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);
const XIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);
const ChevronRight = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
    stroke={C.sub} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6"/>
  </svg>
);

// ═════════════════════════════════════════════════════════════════════════════
export default function ProfilePage() {
  const { user: clerkUser } = useUser();
  const { signOut }         = useClerk();
  const { auto_trade_enabled, risk_pct, oanda_key_hint, updateSettings } = useAuthStore();

  // Build unified user object — Clerk owns identity, store owns settings
  const displayName = clerkUser?.firstName
    ? `${clerkUser.firstName}${clerkUser.lastName ? " " + clerkUser.lastName : ""}`.trim()
    : (clerkUser?.username ?? "Trader");
  const user = {
    name:            displayName,
    email:           clerkUser?.primaryEmailAddress?.emailAddress ?? "",
    auto_trade:      auto_trade_enabled ?? false,
    risk_pct:        risk_pct   ?? 1.0,
    oanda_key_hint:  oanda_key_hint ?? "",
  };

  const [editing,   setEditing]   = useState(null);  // null | "name" | "risk" | "key"
  const [draftName, setDraftName] = useState("");
  const [draftRisk, setDraftRisk] = useState(1.0);
  const [draftKey,  setDraftKey]  = useState("");
  const [saving,    setSaving]    = useState(null);
  const [saveError, setSaveError] = useState(null);

  const openEdit = useCallback((field) => {
    setSaveError(null);
    if (field === "name") setDraftName(user.name);
    if (field === "risk") setDraftRisk(user.risk_pct);
    if (field === "key")  setDraftKey(user.oanda_key_hint);
    setEditing(field);
  }, [user]);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setSaveError(null);
  }, []);

  const commit = useCallback(async (field) => {
    setSaving(field);
    setSaveError(null);
    try {
      const patch =
        field === "name" ? { display_name: draftName.trim() }    :
        field === "risk" ? { risk_pct: parseFloat(draftRisk) }   :
        field === "key"  ? { oanda_key_hint: draftKey.trim() }   : {};
      if (!Object.keys(patch).length) return;
      await updateSettings(patch);
      setEditing(null);
    } catch (err) {
      setSaveError(err?.response?.data?.detail ?? "Save failed — try again");
    } finally {
      setSaving(null);
    }
  }, [draftName, draftRisk, draftKey, updateSettings]);

  return (
    <div style={{ fontFamily: FONT_UI, color: C.white, minHeight: "100%" }}>

      {/* ── Sticky header ─────────────────────────────────────────────────── */}
      <div style={{
        position:       "sticky",
        top:            0,
        zIndex:         20,
        padding:        "16px 16px 12px",
        background:     "rgba(5,5,5,0.97)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderBottom:   "1px solid rgba(0,255,65,0.08)",
      }}>
        <h1 style={{ color: C.white, fontSize: "1.2rem", fontWeight: 700, letterSpacing: "0.03em", margin: 0 }}>
          Profile
        </h1>
      </div>

      {/* ── Scrollable body ───────────────────────────────────────────────── */}
      <div style={{ padding: "20px 16px 40px", display: "flex", flexDirection: "column", gap: 20 }}>

        {/* Avatar + name block */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 320, damping: 26 }}
            style={{
              width:          80,
              height:         80,
              borderRadius:   24,
              display:        "flex",
              alignItems:     "center",
              justifyContent: "center",
              fontSize:       "2rem",
              fontWeight:     700,
              position:       "relative",
              background:     C.greenDim,
              border:         `1px solid ${C.greenBdr}`,
              boxShadow:      "0 0 28px rgba(0,255,65,0.12)",
              color:          C.green,
              fontFamily:     FONT_UI,
            }}
          >
            {user.name.charAt(0).toUpperCase()}
            <div style={{
              position:       "absolute",
              bottom:         -4,
              right:          -4,
              width:          20,
              height:         20,
              borderRadius:   7,
              background:     C.green,
              boxShadow:      "0 0 8px rgba(0,255,65,0.7)",
              display:        "flex",
              alignItems:     "center",
              justifyContent: "center",
            }}>
              <span style={{ fontSize: 10, color: "#000", fontWeight: 700 }}>✓</span>
            </div>
          </motion.div>
          <div style={{ textAlign: "center" }}>
            <p style={{ color: C.white, fontSize: "1.1rem", fontWeight: 700, margin: "0 0 3px" }}>
              {user.name}
            </p>
            <p style={{ color: C.label, fontSize: "0.8rem", margin: 0 }}>{user.email}</p>
          </div>
        </div>

        {/* Error banner */}
        <AnimatePresence>
          {saveError && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              style={{
                overflow:   "hidden",
                borderRadius: 12,
                padding:    "10px 14px",
                background: "rgba(255,58,58,0.08)",
                border:     "1px solid rgba(255,58,58,0.22)",
                color:      C.red,
                fontSize:   "0.78rem",
              }}
            >
              ⚠ {saveError}
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Section 1: User Settings ─────────────────────────────────────── */}
        <Section label="User Settings">
          <EditableRow
            icon="👤" label="Display Name" value={user.name}
            isEditing={editing === "name"} isSaving={saving === "name"}
            onEdit={() => openEdit("name")} onCancel={cancelEdit} onSave={() => commit("name")}
          >
            <input
              autoFocus
              value={draftName}
              onChange={e => setDraftName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") commit("name"); if (e.key === "Escape") cancelEdit(); }}
              placeholder="Your display name"
              maxLength={40}
              style={{
                width:      "100%",
                background: "transparent",
                border:     "none",
                outline:    "none",
                color:      C.white,
                fontSize:   "0.85rem",
                fontFamily: FONT_UI,
                caretColor: C.green,
              }}
            />
          </EditableRow>
          <StaticRow icon="📧" label="Email" value={user.email || "—"} />
        </Section>

        {/* ── Section 2: Risk Configuration ────────────────────────────────── */}
        <Section label="Risk Configuration">
          <EditableRow
            icon="📊" label="Risk % Per Trade" value={`${user.risk_pct.toFixed(1)}%`}
            valueSub={riskLabel(user.risk_pct)}
            isEditing={editing === "risk"} isSaving={saving === "risk"}
            onEdit={() => openEdit("risk")} onCancel={cancelEdit} onSave={() => commit("risk")}
          >
            <RiskSlider value={draftRisk} onChange={setDraftRisk} />
          </EditableRow>
          <StaticRow icon="⚖️" label="Risk / Reward Ratio" value="1 : 3" sub="Fixed by SMC engine — TP is always 3× risk" />
        </Section>

        {/* ── Section 3: API Management ─────────────────────────────────────── */}
        <Section label="API Management">
          <EditableRow
            icon="🔑" label="Oanda API Key"
            value={user.oanda_key_hint ? `•••• ${user.oanda_key_hint}` : "Not set"}
            valueSub="Last 4 characters stored only"
            isEditing={editing === "key"} isSaving={saving === "key"}
            onEdit={() => openEdit("key")} onCancel={cancelEdit} onSave={() => commit("key")}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <input
                autoFocus
                value={draftKey}
                onChange={e => setDraftKey(e.target.value.slice(-4))}
                onKeyDown={e => { if (e.key === "Enter") commit("key"); if (e.key === "Escape") cancelEdit(); }}
                placeholder="Last 4 chars of key"
                maxLength={4}
                style={{
                  width:       "100%",
                  background:  "transparent",
                  border:      "none",
                  outline:     "none",
                  color:       C.white,
                  fontSize:    "0.85rem",
                  fontFamily:  FONT_MONO,
                  letterSpacing: "0.2em",
                  caretColor:  C.green,
                }}
              />
              <p style={{ color: C.sub, fontSize: "0.62rem", margin: 0, letterSpacing: "0.03em" }}>
                Only the last 4 characters are stored. Configure the full key in your backend .env file.
              </p>
            </div>
          </EditableRow>
          <StaticRow icon="🌐" label="Oanda Server" value="Practice" sub="api-fxpractice.oanda.com" />
        </Section>

        {/* ── Section 4: Auto-Trade Status ─────────────────────────────────── */}
        <Section label="Auto-Trade">
          <div style={{
            display:    "flex",
            alignItems: "center",
            gap:        12,
            padding:    "14px 16px",
            background: user.auto_trade ? "rgba(0,255,65,0.05)" : "transparent",
            transition: "background 0.2s",
          }}>
            <div style={{
              width:          40,
              height:         40,
              borderRadius:   12,
              display:        "flex",
              alignItems:     "center",
              justifyContent: "center",
              fontSize:       "1.1rem",
              flexShrink:     0,
              background:     user.auto_trade ? C.greenDim : "rgba(255,255,255,0.04)",
              border:         `1px solid ${user.auto_trade ? C.greenBdr : C.cardBdr}`,
            }}>
              {user.auto_trade ? "⚡" : "🤖"}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ color: C.white, fontSize: "0.88rem", fontWeight: 600, margin: "0 0 2px" }}>
                Master Auto-Trade
              </p>
              <p style={{ color: user.auto_trade ? C.green : C.sub, fontSize: "0.68rem", margin: 0 }}>
                {user.auto_trade ? "ACTIVE — live orders enabled" : "OFF — signals monitored only"}
              </p>
            </div>
            <span style={{
              padding:       "3px 9px",
              borderRadius:  6,
              fontSize:      "0.6rem",
              fontWeight:    700,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              flexShrink:    0,
              background:    user.auto_trade ? C.greenDim : "rgba(255,255,255,0.04)",
              border:        `1px solid ${user.auto_trade ? C.greenBdr : C.cardBdr}`,
              color:         user.auto_trade ? C.green : C.sub,
              fontFamily:    FONT_MONO,
            }}>
              {user.auto_trade ? "ON" : "OFF"}
            </span>
          </div>
          <div style={{ padding: "0 16px 12px" }}>
            <p style={{ color: C.sub, fontSize: "0.7rem", margin: 0 }}>
              Toggle auto-trade from the Account → Summary tab.
            </p>
          </div>
        </Section>

        {/* ── Section 5: Security ──────────────────────────────────────────── */}
        <Section label="Security">
          <StaticRow icon="🔒" label="Authentication" value="Clerk" sub="Managed identity — industry standard" />
          <StaticRow icon="📱" label="Session" value="Active" sub="Managed by Clerk SSO" />
        </Section>

        {/* ── Section 6: About ─────────────────────────────────────────────── */}
        <Section label="About">
          <StaticRow icon="🧠" label="SMC Engine"      value="v1.0.0"   sub="3-layer confluence analysis" />
          <StaticRow icon="📈" label="Instruments"     value="15"       sub="Forex · Metals · Indices · Crypto" />
          <StaticRow icon="⏱"  label="Signal TTL"      value="2 hours" sub="Auto-expires if TP/SL not hit" />
          <StaticRow icon="🔄" label="Candle Refresh"  value="60 s"    sub="H1 · M15 · M5 per instrument" />
        </Section>

        {/* Sign Out button */}
        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={() => signOut()}
          style={{
            width:         "100%",
            padding:       "16px",
            borderRadius:  16,
            background:    "transparent",
            border:        "1px solid rgba(255,58,58,0.22)",
            color:         C.red,
            fontSize:      "0.82rem",
            fontWeight:    600,
            fontFamily:    FONT_UI,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            cursor:        "pointer",
          }}
        >
          Sign Out
        </motion.button>

        <div style={{ height: "env(safe-area-inset-bottom, 16px)" }} />
      </div>
    </div>
  );
}

// ── Risk label helper ─────────────────────────────────────────────────────────
function riskLabel(pct) {
  if (pct <= 1.0) return "Conservative";
  if (pct <= 2.0) return "Standard";
  if (pct <= 4.0) return "Aggressive";
  return "High Risk";
}

// ─────────────────────────────────────────────────────────────────────────────
//  Section wrapper
// ─────────────────────────────────────────────────────────────────────────────
function Section({ label, children }) {
  return (
    <div>
      <p style={{
        color:         C.sub,
        fontSize:      "0.6rem",
        fontWeight:    600,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        margin:        "0 0 8px 4px",
        fontFamily:    FONT_UI,
      }}>
        {label}
      </p>
      <div style={{
        borderRadius: 16,
        overflow:     "hidden",
        background:   C.card,
        border:       `1px solid ${C.cardBdr}`,
      }}>
        {children}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  StaticRow
// ─────────────────────────────────────────────────────────────────────────────
function StaticRow({ icon, label, value, sub, tappable = false, onTap }) {
  const inner = (
    <>
      <div style={{
        width:          36,
        height:         36,
        borderRadius:   11,
        display:        "flex",
        alignItems:     "center",
        justifyContent: "center",
        fontSize:       "1rem",
        flexShrink:     0,
        background:     "rgba(255,255,255,0.04)",
        border:         `1px solid ${C.cardBdr}`,
      }}>
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ color: C.label, fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 2px", fontFamily: FONT_UI }}>
          {label}
        </p>
        <p style={{ color: C.white, fontSize: "0.85rem", fontWeight: 500, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {value}
        </p>
        {sub && (
          <p style={{ color: C.sub, fontSize: "0.62rem", margin: "2px 0 0" }}>{sub}</p>
        )}
      </div>
      {tappable && <ChevronRight />}
    </>
  );

  const rowStyle = {
    display:    "flex",
    alignItems: "center",
    gap:        12,
    padding:    "12px 16px",
    borderTop:  `1px solid ${C.cardBdr}`,
  };

  // Remove top border from first child via CSS-like approach
  // (We use a wrapper div so the first child just gets no special treatment)
  if (tappable) {
    return (
      <button
        onClick={onTap}
        style={{ ...rowStyle, background: "transparent", border: "none", borderTop: `1px solid ${C.cardBdr}`, width: "100%", cursor: "pointer", textAlign: "left" }}
      >
        {inner}
      </button>
    );
  }
  return <div style={rowStyle}>{inner}</div>;
}

// ─────────────────────────────────────────────────────────────────────────────
//  EditableRow
// ─────────────────────────────────────────────────────────────────────────────
function EditableRow({ icon, label, value, valueSub, isEditing, isSaving, onEdit, onCancel, onSave, children }) {
  return (
    <motion.div
      layout
      style={{
        background:  isEditing ? "rgba(0,255,65,0.03)" : "transparent",
        borderTop:   `1px solid ${C.cardBdr}`,
        boxShadow:   isEditing ? "inset 0 0 0 1px rgba(0,255,65,0.2)" : "none",
        transition:  "background 0.2s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" }}>
        {/* Icon */}
        <div style={{
          width:          36,
          height:         36,
          borderRadius:   11,
          display:        "flex",
          alignItems:     "center",
          justifyContent: "center",
          fontSize:       "1rem",
          flexShrink:     0,
          background:     isEditing ? C.greenDim : "rgba(255,255,255,0.04)",
          border:         `1px solid ${isEditing ? C.greenBdr : C.cardBdr}`,
          transition:     "background 0.2s, border-color 0.2s",
        }}>
          {icon}
        </div>

        {/* Label + value */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ color: C.label, fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 2px", fontFamily: FONT_UI }}>
            {label}
          </p>
          {!isEditing && (
            <p style={{ color: C.white, fontSize: "0.85rem", fontWeight: 500, margin: 0 }}>
              {value}
            </p>
          )}
          {!isEditing && valueSub && (
            <p style={{ color: C.sub, fontSize: "0.62rem", margin: "2px 0 0" }}>{valueSub}</p>
          )}
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {!isEditing && (
            <button
              onClick={onEdit}
              style={{
                width:          32,
                height:         32,
                borderRadius:   10,
                display:        "flex",
                alignItems:     "center",
                justifyContent: "center",
                background:     "rgba(255,255,255,0.04)",
                border:         `1px solid ${C.cardBdr}`,
                color:          C.sub,
                cursor:         "pointer",
              }}
              aria-label={`Edit ${label}`}
            >
              <PencilIcon />
            </button>
          )}
          {isEditing && (
            <>
              <button
                onClick={onCancel}
                disabled={isSaving}
                style={{
                  width:    32, height: 32, borderRadius: 10,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: "rgba(255,58,58,0.1)", border: "1px solid rgba(255,58,58,0.22)",
                  color: C.red, cursor: "pointer", opacity: isSaving ? 0.5 : 1,
                }}
              >
                <XIcon />
              </button>
              <button
                onClick={onSave}
                disabled={isSaving}
                style={{
                  width:    32, height: 32, borderRadius: 10,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: C.greenDim, border: `1px solid ${C.greenBdr}`,
                  color: C.green, cursor: "pointer", opacity: isSaving ? 0.6 : 1,
                }}
              >
                {isSaving ? (
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 0.6, repeat: Infinity, ease: "linear" }}
                    style={{
                      width: 13, height: 13, borderRadius: "50%",
                      border: "2px solid transparent", borderTopColor: C.green,
                    }}
                  />
                ) : <CheckIcon />}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Inline edit area */}
      <AnimatePresence>
        {isEditing && (
          <motion.div
            initial={{ opacity: 0, height: 0, marginTop: 0 }}
            animate={{ opacity: 1, height: "auto", marginTop: 0 }}
            exit={{ opacity: 0, height: 0 }}
            style={{ overflow: "hidden" }}
          >
            <div style={{
              margin:       "0 16px 14px",
              padding:      "10px 12px",
              borderRadius: 10,
              background:   "rgba(0,0,0,0.45)",
              border:       `1px solid rgba(0,255,65,0.18)`,
            }}>
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  RiskSlider
// ─────────────────────────────────────────────────────────────────────────────
function RiskSlider({ value, onChange }) {
  const pct   = ((value - 0.1) / (10.0 - 0.1)) * 100;
  const color = value <= 2.0 ? C.green : value <= 5.0 ? C.amber : C.red;
  const tier  = riskLabel(value);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <span style={{ color, fontSize: "1.6rem", fontWeight: 700, fontFamily: FONT_MONO, textShadow: `0 0 10px ${color}55` }}>
          {parseFloat(value).toFixed(1)}%
        </span>
        <span style={{
          fontSize: "0.62rem", fontWeight: 600, letterSpacing: "0.08em",
          padding: "3px 8px", borderRadius: 6,
          background: `${color}12`, border: `1px solid ${color}30`, color,
          fontFamily: FONT_UI,
        }}>
          {tier}
        </span>
      </div>

      <div style={{ position: "relative" }}>
        <div style={{
          position:   "absolute",
          top:        "50%",
          left:       0,
          height:     6,
          borderRadius: 3,
          pointerEvents: "none",
          width:      `${pct}%`,
          transform:  "translateY(-50%)",
          background: `linear-gradient(90deg, #00FF41, ${color})`,
          boxShadow:  `0 0 6px ${color}55`,
          transition: "width 0.05s, background 0.2s",
        }} />
        <input
          type="range"
          min="0.1" max="10.0" step="0.1"
          value={value}
          onChange={e => onChange(parseFloat(e.target.value))}
          style={{
            WebkitAppearance: "none",
            appearance:       "none",
            width:            "100%",
            height:           6,
            borderRadius:     3,
            background:       "rgba(255,255,255,0.06)",
            outline:          "none",
            cursor:           "pointer",
            position:         "relative",
            zIndex:           1,
          }}
        />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.58rem", color: C.sub, fontFamily: FONT_MONO }}>
        <span>0.1%</span><span>2.5%</span><span>5%</span><span>7.5%</span><span>10%</span>
      </div>

      <div style={{
        padding: "8px 10px", borderRadius: 8,
        background: "rgba(0,0,0,0.35)", border: `1px solid ${C.cardBdr}`,
        color: C.sub, fontSize: "0.68rem", lineHeight: 1.5, fontFamily: FONT_UI,
      }}>
        Each trade risks {parseFloat(value).toFixed(1)}% of account.
        At $10,000 that is ${(10000 * value / 100).toFixed(0)} per trade.
      </div>
    </div>
  );
}

// ── Inject range slider thumb styles (webkit/moz can't be done inline) ────────
if (typeof document !== "undefined" && !document.getElementById("fx-range-style")) {
  const s    = document.createElement("style");
  s.id       = "fx-range-style";
  s.textContent = [
    "input[type='range']::-webkit-slider-thumb {",
    "  -webkit-appearance:none; width:20px; height:20px;",
    "  border-radius:50%; background:#00FF41;",
    "  box-shadow:0 0 8px rgba(0,255,65,0.7);",
    "  cursor:pointer; border:2px solid #000;",
    "}",
    "input[type='range']::-webkit-slider-thumb:active {",
    "  box-shadow:0 0 16px rgba(0,255,65,1);",
    "}",
    "input[type='range']::-moz-range-thumb {",
    "  width:20px; height:20px; border-radius:50%;",
    "  background:#00FF41; box-shadow:0 0 8px rgba(0,255,65,0.7);",
    "  cursor:pointer; border:2px solid #000;",
    "}",
  ].join("\n");
  document.head.appendChild(s);
}