/**
 * ProfilePage — Dual-Engine
 * ══════════════════════════════════════════════════════════════════════════════
 * FOREX mode  → Shows OandaCredentialsSection (API key + account ID)
 * CRYPTO mode → Shows BybitCredentialsSection (API key + API secret)
 *               If no personal Bybit key is saved, a "Read-Only Mode" notice
 *               informs the user that charts/market data work via the global
 *               fallback key, but account data and trading require their own key.
 *
 * All accent-colour elements (avatar, borders, edit highlights, form buttons,
 * risk slider) are driven by useTheme() so they follow the FOREX/CRYPTO mode
 * in real time with no flash.  The range-thumb CSS uses var(--accent) which
 * is kept in sync by authStore._persistMode() on every toggle.
 *
 * Font: Inter (UI)  ·  JetBrains Mono (numbers / keys)
 */
import { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence }            from "framer-motion";
import { useAuthStore }                       from "../store/authStore";
import { useTheme }                           from "../hooks/useTheme";
import { useUser, useClerk, useAuth }         from "@clerk/clerk-react";

// ── Static colour tokens (not mode-dependent) ─────────────────────────────────
const C = {
  red:     "#FF3A3A",
  amber:   "#FFB800",
  white:   "#ffffff",
  label:   "#aaaaaa",
  sub:     "#666666",
  card:    "#0f0f0f",
  cardBdr: "rgba(255,255,255,0.07)",
  sheet:   "#141414",
};
const FONT_UI   = "'Inter', sans-serif";
const FONT_MONO = "'JetBrains Mono', monospace";

// ── Icons ─────────────────────────────────────────────────────────────────────
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

// ── Inject range-thumb CSS once, using CSS var(--accent) ─────────────────────
// var(--accent) is set synchronously by the anti-flash script in index.html
// and kept in sync by authStore._persistMode() on every toggle, so the thumb
// colour always matches the current mode without any JS re-injection.
function ensureRangeStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById("fx-range-style")) return;
  const s = document.createElement("style");
  s.id = "fx-range-style";
  s.textContent = [
    "input[type='range']::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px rgba(0,0,0,0);cursor:pointer;border:2px solid #000;transition:background 0.4s;}",
    "input[type='range']::-webkit-slider-thumb:active{box-shadow:0 0 16px var(--accent);}",
    "input[type='range']::-moz-range-thumb{width:20px;height:20px;border-radius:50%;background:var(--accent);cursor:pointer;border:2px solid #000;transition:background 0.4s;}",
  ].join("\n");
  document.head.appendChild(s);
}

// ═════════════════════════════════════════════════════════════════════════════
export default function ProfilePage() {
  const { user: clerkUser } = useUser();
  const { signOut }         = useClerk();
  const {
    oanda_risk_pct, bybit_risk_pct,
    fetchProfile, updateOandaRisk, updateBybitRisk,
  } = useAuthStore();
  const { getToken } = useAuth();
  const { isCrypto, accent, accentDim, accentBdr } = useTheme();

  // Ensure range-thumb CSS is injected once
  useEffect(() => { ensureRangeStyles(); }, []);

  const displayName = clerkUser?.firstName
    ? `${clerkUser.firstName}${clerkUser.lastName ? " " + clerkUser.lastName : ""}`.trim()
    : (clerkUser?.username ?? "Trader");

  const user = {
    name:           displayName,
    email:          clerkUser?.primaryEmailAddress?.emailAddress ?? "",
    oanda_risk_pct: oanda_risk_pct ?? 1.0,
    bybit_risk_pct: bybit_risk_pct ?? 20.0,
  };

  // Fetch profile from backend once on mount
  useEffect(() => {
    getToken().then(token => fetchProfile(token)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Editing state ─────────────────────────────────────────────────────────
  const [editing,        setEditing]        = useState(null);
  const [draftName,      setDraftName]      = useState("");
  const [draftOandaRisk, setDraftOandaRisk] = useState(1.0);
  const [draftBybitRisk, setDraftBybitRisk] = useState(20.0);
  const [saving,         setSaving]         = useState(null);
  const [saveError,      setSaveError]      = useState(null);

  const openEdit = useCallback((field) => {
    setSaveError(null);
    if (field === "name")       setDraftName(user.name);
    if (field === "oanda_risk") setDraftOandaRisk(user.oanda_risk_pct);
    if (field === "bybit_risk") setDraftBybitRisk(user.bybit_risk_pct);
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
      const token = await getToken();
      if (field === "oanda_risk") await updateOandaRisk(draftOandaRisk, token);
      if (field === "bybit_risk") await updateBybitRisk(draftBybitRisk, token);
      setEditing(null);
    } catch (err) {
      setSaveError(err?.response?.data?.detail ?? "Save failed — try again");
    } finally {
      setSaving(null);
    }
  }, [draftOandaRisk, draftBybitRisk, getToken, updateOandaRisk, updateBybitRisk]);

  return (
    <div style={{ fontFamily: FONT_UI, color: C.white, minHeight: "100%" }}>

      {/* ── Sticky header ─────────────────────────────────────────────────── */}
      <div style={{
        position:             "sticky",
        top:                  0,
        zIndex:               20,
        padding:              "16px 16px 12px",
        background:           "rgba(5,5,5,0.97)",
        backdropFilter:       "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderBottom:         `1px solid ${accent}14`,
        transition:           "border-color 0.4s ease",
      }}>
        <h1 style={{
          color: C.white, fontSize: "1.2rem", fontWeight: 700,
          letterSpacing: "0.03em", margin: 0,
        }}>
          Profile
        </h1>
      </div>

      <div style={{ padding: "20px 16px 40px", display: "flex", flexDirection: "column", gap: 20 }}>

        {/* ── Avatar ──────────────────────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <motion.div
            animate={{
              background:  `${accent}1a`,
              border:      `1px solid ${accentBdr}`,
              boxShadow:   `0 0 28px ${accent}1f`,
              color:       accent,
            }}
            transition={{ duration: 0.4 }}
            initial={false}
            style={{
              width: 80, height: 80, borderRadius: 24,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "2rem", fontWeight: 700, position: "relative",
            }}
          >
            {user.name.charAt(0).toUpperCase()}
            <motion.div
              animate={{ background: accent, boxShadow: `0 0 8px ${accent}b3` }}
              transition={{ duration: 0.4 }}
              initial={false}
              style={{
                position: "absolute", bottom: -4, right: -4,
                width: 20, height: 20, borderRadius: 7,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <span style={{ fontSize: 10, color: "#000", fontWeight: 700 }}>✓</span>
            </motion.div>
          </motion.div>
          <div style={{ textAlign: "center" }}>
            <p style={{ color: C.white, fontSize: "1.1rem", fontWeight: 700, margin: "0 0 3px" }}>{user.name}</p>
            <p style={{ color: C.label, fontSize: "0.8rem", margin: 0 }}>{user.email}</p>
            {/* Mode badge under avatar */}
            <motion.div
              animate={{ background: accentDim, border: `1px solid ${accentBdr}`, color: accent }}
              transition={{ duration: 0.4 }}
              initial={false}
              style={{
                display:       "inline-flex",
                alignItems:    "center",
                gap:           5,
                marginTop:     6,
                padding:       "3px 10px",
                borderRadius:  99,
                fontSize:      "0.6rem",
                fontWeight:    700,
                letterSpacing: "0.1em",
                fontFamily:    FONT_MONO,
              }}
            >
              {isCrypto ? "₿ CRYPTO MODE" : "FX MODE"}
            </motion.div>
          </div>
        </div>

        {/* ── Global error banner ─────────────────────────────────────────── */}
        <AnimatePresence>
          {saveError && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              style={{
                overflow: "hidden", borderRadius: 12, padding: "10px 14px",
                background: "rgba(255,58,58,0.08)", border: "1px solid rgba(255,58,58,0.22)",
                color: C.red, fontSize: "0.78rem",
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
              autoFocus value={draftName}
              onChange={e => setDraftName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") commit("name"); if (e.key === "Escape") cancelEdit(); }}
              placeholder="Your display name" maxLength={40}
              style={{
                width: "100%", background: "transparent", border: "none", outline: "none",
                color: C.white, fontSize: "0.85rem", fontFamily: FONT_UI,
                caretColor: accent,
              }}
            />
          </EditableRow>
          <StaticRow icon="📧" label="Email" value={user.email || "—"} />
        </Section>

        {/* ── Credentials note — Private Bot Mode ────────────────────────── */}
        {/* In Private Bot Mode all credentials live in the server .env.    */}
        {/* No per-user key entry is needed or shown.                        */}
        <Section label={isCrypto ? "Bybit Connection" : "Oanda Connection"}>
          <StaticRow
            icon="🔗"
            label="Connection Mode"
            value="Private Bot"
            sub="Credentials managed server-side via .env — no key entry required"
          />
          <StaticRow
            icon={isCrypto ? "₿" : "📈"}
            label={isCrypto ? "Exchange" : "Broker"}
            value={isCrypto ? "Bybit Perpetuals" : "Oanda v20"}
            sub={isCrypto ? "Linear USDT · 20× max leverage" : "Forex · Metals · Indices"}
          />
        </Section>

        {/* ── Section 2: Risk Configuration — mode-aware ──────────────────── */}
        {/* FOREX mode shows only Oanda risk; CRYPTO mode shows only Bybit risk. */}
        <AnimatePresence mode="wait">
          {isCrypto ? (
            <motion.div
              key="bybit-risk"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22 }}
            >
              <Section label="Bybit Risk Configuration">
                <EditableRow
                  icon="📊"
                  label="Bybit Risk % Per Trade"
                  value={`${user.bybit_risk_pct.toFixed(0)}%`}
                  valueSub={bybitRiskLabel(user.bybit_risk_pct)}
                  isEditing={editing === "bybit_risk"}
                  isSaving={saving === "bybit_risk"}
                  onEdit={() => openEdit("bybit_risk")}
                  onCancel={cancelEdit}
                  onSave={() => commit("bybit_risk")}
                >
                  <BybitRiskSlider value={draftBybitRisk} onChange={setDraftBybitRisk} />
                </EditableRow>
                <StaticRow icon="⚖️" label="Risk / Reward Ratio" value="1 : 3" sub="Fixed by SMC engine" />
                <StaticRow
                  icon="ℹ️" label="Why 20%?"
                  value="Small capital sizing"
                  sub="Crypto accounts are typically $200–$500. Higher % is needed to clear exchange minimums."
                />
              </Section>
            </motion.div>
          ) : (
            <motion.div
              key="oanda-risk"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22 }}
            >
              <Section label="Oanda Risk Configuration">
                <EditableRow
                  icon="📊"
                  label="Oanda Risk % Per Trade"
                  value={`${user.oanda_risk_pct.toFixed(1)}%`}
                  valueSub={oandaRiskLabel(user.oanda_risk_pct)}
                  isEditing={editing === "oanda_risk"}
                  isSaving={saving === "oanda_risk"}
                  onEdit={() => openEdit("oanda_risk")}
                  onCancel={cancelEdit}
                  onSave={() => commit("oanda_risk")}
                >
                  <OandaRiskSlider value={draftOandaRisk} onChange={setDraftOandaRisk} />
                </EditableRow>
                <StaticRow icon="⚖️" label="Risk / Reward Ratio" value="1 : 3" sub="Fixed by SMC engine" />
                <StaticRow
                  icon="ℹ️" label="Why 1%?"
                  value="Industry standard"
                  sub="A $10,000 Oanda account risks $100 per signal. Preserves capital across losing streaks."
                />
              </Section>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Section 3: Auto-Trade Status ─────────────────────────────────── */}
        <Section label="Auto-Trade">
          <StaticRow
            icon="⚡"
            label="Master Auto-Trade"
            value="Active"
            sub="Toggle from Account → Summary tab"
          />
        </Section>

        {/* ── Section 4: Security ──────────────────────────────────────────── */}
        <Section label="Security">
          <StaticRow icon="🔒" label="Authentication" value="Clerk" sub="Managed identity · industry standard" />
          <StaticRow icon="📱" label="Session"        value="Active" sub="Managed by Clerk SSO" />
        </Section>

        {/* ── Section 5: About ─────────────────────────────────────────────── */}
        <Section label="About">
          <StaticRow icon="🧠" label="SMC Engine"     value="v1.0.0"  sub="3-layer confluence analysis" />
          <StaticRow icon="📈" label="Instruments"    value={isCrypto ? "15 Perpetuals" : "15"} sub={isCrypto ? "Bybit Linear · Top volume" : "Forex · Metals · Indices · Crypto"} />
          <StaticRow icon="⏱"  label="Signal TTL"     value="2 hours" sub="Auto-expires if TP/SL not hit" />
          <StaticRow icon="🔄" label="Candle Refresh" value="60 s"    sub="H1 · M15 · M5 · M1 per instrument" />
        </Section>

        {/* ── Sign Out ─────────────────────────────────────────────────────── */}
        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={() => signOut()}
          style={{
            width: "100%", padding: "16px", borderRadius: 16,
            background: "transparent", border: "1px solid rgba(255,58,58,0.22)",
            color: C.red, fontSize: "0.82rem", fontWeight: 600, fontFamily: FONT_UI,
            letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer",
          }}
        >Sign Out</motion.button>

        <div style={{ height: "env(safe-area-inset-bottom, 16px)" }} />
      </div>
    </div>
  );
}


// ═════════════════════════════════════════════════════════════════════════════
//  OandaCredentialsSection — FOREX mode credentials form
// ═════════════════════════════════════════════════════════════════════════════
function OandaCredentialsSection({ keyHint, accountId, saveOandaCredentials }) {
  const { accent, accentDim, accentBdr } = useTheme();
  const [open,       setOpen]       = useState(false);
  const [apiKey,     setApiKey]     = useState("");
  const [accountVal, setAccountVal] = useState("");
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState(null);
  const [success,    setSuccess]    = useState(false);

  const hasCredentials = Boolean(keyHint && accountId);

  const handleOpen = () => {
    setOpen(true);
    setApiKey("");
    setAccountVal(accountId || "");
    setError(null);
    setSuccess(false);
  };
  const handleCancel = () => { setOpen(false); setError(null); };
  const handleSave   = async () => {
    if (!apiKey.trim() || !accountVal.trim()) { setError("Both fields are required."); return; }
    setSaving(true); setError(null);
    try {
      await saveOandaCredentials(apiKey.trim(), accountVal.trim());
      setSuccess(true); setOpen(false);
    } catch (err) {
      setError(err?.response?.data?.detail ?? "Save failed — check your credentials.");
    } finally { setSaving(false); }
  };

  return (
    <div>
      <p style={{
        color: C.sub, fontSize: "0.6rem", fontWeight: 600,
        letterSpacing: "0.12em", textTransform: "uppercase",
        margin: "0 0 8px 4px", fontFamily: FONT_UI,
      }}>
        Oanda Credentials
      </p>

      <motion.div
        animate={{ border: `1px solid ${hasCredentials ? accentBdr : C.cardBdr}` }}
        transition={{ duration: 0.4 }}
        style={{
          borderRadius: 16, overflow: "hidden",
          background: C.card,
          boxShadow: hasCredentials ? `0 0 20px ${accent}0d` : "none",
        }}
      >
        {/* Status row */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px" }}>
          <motion.div
            animate={{
              background: hasCredentials ? accentDim : "rgba(255,255,255,0.04)",
              border: `1px solid ${hasCredentials ? accentBdr : C.cardBdr}`,
            }}
            transition={{ duration: 0.3 }}
            style={{
              width: 40, height: 40, borderRadius: 12, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.1rem",
            }}
          >
            {hasCredentials ? "✅" : "🔑"}
          </motion.div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ color: C.white, fontSize: "0.88rem", fontWeight: 600, margin: "0 0 2px", fontFamily: FONT_UI }}>
              {hasCredentials ? "Credentials Saved" : "Not Configured"}
            </p>
            {hasCredentials ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <p style={{ color: C.label, fontSize: "0.68rem", margin: 0, fontFamily: FONT_MONO }}>
                  Key: •••• {keyHint}
                </p>
                <p style={{ color: C.label, fontSize: "0.68rem", margin: 0, fontFamily: FONT_MONO }}>
                  Account: {accountId}
                </p>
              </div>
            ) : (
              <p style={{ color: C.sub, fontSize: "0.68rem", margin: 0, fontFamily: FONT_UI }}>
                Add your Oanda API key to enable account data and live trading.
              </p>
            )}
          </div>

          <button
            onClick={handleOpen}
            style={{
              width: 32, height: 32, borderRadius: 10, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "rgba(255,255,255,0.04)", border: `1px solid ${C.cardBdr}`,
              color: C.sub, cursor: "pointer",
            }}
            aria-label="Edit Oanda credentials"
          >
            <PencilIcon />
          </button>
        </div>

        {/* Success flash */}
        <AnimatePresence>
          {success && (
            <motion.div
              initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
              style={{ overflow: "hidden" }}
              onAnimationComplete={() => setTimeout(() => setSuccess(false), 3000)}
            >
              <div style={{
                margin: "0 16px 14px", padding: "10px 14px", borderRadius: 10,
                background: `${accent}14`, border: `1px solid ${accentBdr}`,
                color: accent, fontSize: "0.75rem", fontFamily: FONT_UI,
              }}>
                ✓ Credentials verified and saved to Supabase.
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Inline form */}
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
              style={{ overflow: "hidden" }}
            >
              <div style={{ margin: "0 16px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
                <CredentialField label="Oanda API Key" type="password" value={apiKey} onChange={setApiKey}
                  placeholder="Your full Oanda personal access token" autoFocus
                  hint="Generate at: Oanda → My Account → Manage API Access. The full key is never stored in the browser."
                />
                <CredentialField label="Oanda Account ID" type="text" value={accountVal} onChange={setAccountVal}
                  placeholder="e.g. 101-001-0000000-001"
                />
                <CredErrorAndButtons error={error} saving={saving} onCancel={handleCancel} onSave={handleSave} />
                <p style={{ color: C.sub, fontSize: "0.65rem", lineHeight: 1.5, margin: 0, fontFamily: FONT_UI }}>
                  Credentials are verified against Oanda before being encrypted and stored in Supabase. Never logged or returned to client.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}


// ═════════════════════════════════════════════════════════════════════════════
//  BybitCredentialsSection — CRYPTO mode credentials form
//
//  Read-Only Fallback:
//    If bybit_key_hint === "", the user has no personal Bybit key saved.
//    The backend automatically uses the global BYBIT_PUBLIC_API_KEY from its
//    own .env for read-only market data.  A notice is shown here to inform
//    the user they can unlock account data and trading by adding their key.
// ═════════════════════════════════════════════════════════════════════════════
function BybitCredentialsSection({ keyHint, secretHint, saveBybitCredentials }) {
  const { accent, accentDim, accentBdr } = useTheme();
  const [open,       setOpen]       = useState(false);
  const [apiKey,     setApiKey]     = useState("");
  const [apiSecret,  setApiSecret]  = useState("");
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState(null);
  const [success,    setSuccess]    = useState(false);

  const hasCredentials = Boolean(keyHint);
  const isReadOnly     = !hasCredentials;

  const handleOpen   = () => { setOpen(true); setApiKey(""); setApiSecret(""); setError(null); setSuccess(false); };
  const handleCancel = () => { setOpen(false); setError(null); };
  const handleSave   = async () => {
    if (!apiKey.trim() || !apiSecret.trim()) { setError("Both API Key and Secret are required."); return; }
    setSaving(true); setError(null);
    try {
      await saveBybitCredentials(apiKey.trim(), apiSecret.trim());
      setSuccess(true); setOpen(false);
    } catch (err) {
      setError(err?.response?.data?.detail ?? "Save failed — check your credentials.");
    } finally { setSaving(false); }
  };

  return (
    <div>
      <p style={{
        color: C.sub, fontSize: "0.6rem", fontWeight: 600,
        letterSpacing: "0.12em", textTransform: "uppercase",
        margin: "0 0 8px 4px", fontFamily: FONT_UI,
      }}>
        Bybit Credentials
      </p>

      {/* Read-Only Mode notice — shown only when no personal key is saved */}
      <AnimatePresence>
        {isReadOnly && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            style={{ overflow: "hidden", marginBottom: 10 }}
          >
            <div style={{
              padding: "10px 14px", borderRadius: 12,
              background: "rgba(255,184,0,0.06)",
              border: "1px solid rgba(255,184,0,0.22)",
              display: "flex", alignItems: "flex-start", gap: 10,
            }}>
              <span style={{ fontSize: "1rem", flexShrink: 0 }}>📡</span>
              <div>
                <p style={{ color: C.amber, fontSize: "0.75rem", fontWeight: 700, margin: "0 0 3px", fontFamily: FONT_UI }}>
                  Read-Only Mode
                </p>
                <p style={{ color: C.sub, fontSize: "0.68rem", margin: 0, lineHeight: 1.5, fontFamily: FONT_UI }}>
                  Charts and market data work via a global shared key.
                  Add your personal Bybit API key to unlock account data and live trading.
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        animate={{ border: `1px solid ${hasCredentials ? accentBdr : C.cardBdr}` }}
        transition={{ duration: 0.4 }}
        style={{
          borderRadius: 16, overflow: "hidden",
          background: C.card,
          boxShadow: hasCredentials ? `0 0 20px ${accent}0d` : "none",
        }}
      >
        {/* Status row */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px" }}>
          <motion.div
            animate={{
              background: hasCredentials ? accentDim : "rgba(255,255,255,0.04)",
              border: `1px solid ${hasCredentials ? accentBdr : C.cardBdr}`,
            }}
            transition={{ duration: 0.3 }}
            style={{
              width: 40, height: 40, borderRadius: 12, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.1rem",
            }}
          >
            {hasCredentials ? "✅" : "🔑"}
          </motion.div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ color: C.white, fontSize: "0.88rem", fontWeight: 600, margin: "0 0 2px", fontFamily: FONT_UI }}>
              {hasCredentials ? "Personal Key Saved" : "Using Global Key"}
            </p>
            {hasCredentials ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <p style={{ color: C.label, fontSize: "0.68rem", margin: 0, fontFamily: FONT_MONO }}>
                  API Key: •••• {keyHint}
                </p>
                {secretHint && (
                  <p style={{ color: C.label, fontSize: "0.68rem", margin: 0, fontFamily: FONT_MONO }}>
                    Secret: •••• {secretHint}
                  </p>
                )}
              </div>
            ) : (
              <p style={{ color: C.sub, fontSize: "0.68rem", margin: 0, fontFamily: FONT_UI }}>
                Read-only market data active. Add your key for account access.
              </p>
            )}
          </div>

          <button
            onClick={handleOpen}
            style={{
              width: 32, height: 32, borderRadius: 10, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "rgba(255,255,255,0.04)", border: `1px solid ${C.cardBdr}`,
              color: C.sub, cursor: "pointer",
            }}
            aria-label="Edit Bybit credentials"
          >
            <PencilIcon />
          </button>
        </div>

        {/* Success flash */}
        <AnimatePresence>
          {success && (
            <motion.div
              initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
              style={{ overflow: "hidden" }}
              onAnimationComplete={() => setTimeout(() => setSuccess(false), 3000)}
            >
              <div style={{
                margin: "0 16px 14px", padding: "10px 14px", borderRadius: 10,
                background: `${accent}14`, border: `1px solid ${accentBdr}`,
                color: accent, fontSize: "0.75rem", fontFamily: FONT_UI,
              }}>
                ✓ Bybit credentials verified and saved to Supabase.
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Inline form */}
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
              style={{ overflow: "hidden" }}
            >
              <div style={{ margin: "0 16px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
                <CredentialField label="Bybit API Key" type="password" value={apiKey} onChange={setApiKey}
                  placeholder="Your Bybit API key" autoFocus
                  hint="Generate at: Bybit → Account & Security → API Management. Tick 'Read' + 'Trade' for full access."
                />
                <CredentialField label="Bybit API Secret" type="password" value={apiSecret} onChange={setApiSecret}
                  placeholder="Your Bybit API secret"
                  hint="The secret is only shown once on Bybit. Treat it like a password."
                />
                <CredErrorAndButtons error={error} saving={saving} onCancel={handleCancel} onSave={handleSave}
                  saveLabel="Save & Verify"
                />
                <p style={{ color: C.sub, fontSize: "0.65rem", lineHeight: 1.5, margin: 0, fontFamily: FONT_UI }}>
                  Credentials are verified against Bybit before being encrypted and stored in Supabase. Never logged or returned to client.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
//  Shared sub-components for credential forms
// ─────────────────────────────────────────────────────────────────────────────
function CredentialField({ label, type, value, onChange, placeholder, hint, autoFocus }) {
  const { accent } = useTheme();
  return (
    <div>
      <p style={{
        color: C.label, fontSize: "0.62rem", letterSpacing: "0.1em",
        textTransform: "uppercase", margin: "0 0 6px", fontFamily: FONT_UI,
      }}>
        {label}
      </p>
      <input
        autoFocus={autoFocus ?? false}
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%", padding: "10px 12px", borderRadius: 10, boxSizing: "border-box",
          background: C.sheet, border: `1px solid ${C.cardBdr}`,
          color: C.white, fontSize: "0.82rem", fontFamily: FONT_MONO,
          outline: "none", caretColor: accent,
        }}
      />
      {hint && (
        <p style={{ color: C.sub, fontSize: "0.62rem", margin: "5px 0 0", fontFamily: FONT_UI }}>
          {hint}
        </p>
      )}
    </div>
  );
}

function CredErrorAndButtons({ error, saving, onCancel, onSave, saveLabel = "Save & Verify" }) {
  const { accent, accentDim, accentBdr } = useTheme();
  return (
    <>
      <AnimatePresence>
        {error && (
          <motion.p
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ color: C.red, fontSize: "0.72rem", margin: 0, fontFamily: FONT_UI }}
          >
            ✕ {error}
          </motion.p>
        )}
      </AnimatePresence>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={onCancel} disabled={saving}
          style={{
            flex: 1, padding: "10px", borderRadius: 10, cursor: "pointer",
            background: "transparent", border: `1px solid ${C.cardBdr}`,
            color: C.label, fontSize: "0.78rem", fontFamily: FONT_UI,
          }}
        >Cancel</button>
        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={onSave} disabled={saving}
          style={{
            flex: 2, padding: "10px", borderRadius: 10,
            cursor: saving ? "not-allowed" : "pointer",
            background: saving ? `${accent}14` : accentDim,
            border: `1px solid ${accentBdr}`,
            color: accent, fontSize: "0.78rem", fontWeight: 700,
            fontFamily: FONT_UI, letterSpacing: "0.05em",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}
        >
          {saving ? (
            <>
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 0.7, repeat: Infinity, ease: "linear" }}
                style={{
                  width: 12, height: 12, borderRadius: "50%",
                  border: "2px solid transparent", borderTopColor: accent,
                }}
              />
              Verifying…
            </>
          ) : saveLabel}
        </motion.button>
      </div>
    </>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
//  Layout helpers — Section, StaticRow, EditableRow
//  All use useTheme() directly so accent colours follow mode in real time.
// ─────────────────────────────────────────────────────────────────────────────
function Section({ label, children }) {
  return (
    <div>
      <p style={{
        color: C.sub, fontSize: "0.6rem", fontWeight: 600,
        letterSpacing: "0.12em", textTransform: "uppercase",
        margin: "0 0 8px 4px", fontFamily: FONT_UI,
      }}>
        {label}
      </p>
      <div style={{ borderRadius: 16, overflow: "hidden", background: C.card, border: `1px solid ${C.cardBdr}` }}>
        {children}
      </div>
    </div>
  );
}

function StaticRow({ icon, label, value, sub, tappable = false, onTap }) {
  const inner = (
    <>
      <div style={{
        width: 36, height: 36, borderRadius: 11, flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1rem",
        background: "rgba(255,255,255,0.04)", border: `1px solid ${C.cardBdr}`,
      }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ color: C.label, fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 2px", fontFamily: FONT_UI }}>{label}</p>
        <p style={{ color: C.white, fontSize: "0.85rem", fontWeight: 500, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</p>
        {sub && <p style={{ color: C.sub, fontSize: "0.62rem", margin: "2px 0 0" }}>{sub}</p>}
      </div>
      {tappable && <ChevronRight />}
    </>
  );
  const rowStyle = { display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: `1px solid ${C.cardBdr}` };
  if (tappable) {
    return <button onClick={onTap} style={{ ...rowStyle, background: "transparent", border: "none", width: "100%", cursor: "pointer", textAlign: "left" }}>{inner}</button>;
  }
  return <div style={rowStyle}>{inner}</div>;
}

function EditableRow({ icon, label, value, valueSub, isEditing, isSaving, onEdit, onCancel, onSave, children }) {
  const { accent, accentDim, accentBdr } = useTheme();
  return (
    <motion.div layout style={{
      background: isEditing ? `${accent}08` : "transparent",
      borderTop: `1px solid ${C.cardBdr}`,
      boxShadow: isEditing ? `inset 0 0 0 1px ${accent}33` : "none",
      transition: "background 0.25s",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" }}>
        <motion.div
          animate={{
            background: isEditing ? accentDim : "rgba(255,255,255,0.04)",
            border:     `1px solid ${isEditing ? accentBdr : C.cardBdr}`,
          }}
          transition={{ duration: 0.2 }}
          style={{
            width: 36, height: 36, borderRadius: 11, flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1rem",
          }}
        >{icon}</motion.div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ color: C.label, fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 2px", fontFamily: FONT_UI }}>{label}</p>
          {!isEditing && <p style={{ color: C.white, fontSize: "0.85rem", fontWeight: 500, margin: 0 }}>{value}</p>}
          {!isEditing && valueSub && <p style={{ color: C.sub, fontSize: "0.62rem", margin: "2px 0 0" }}>{valueSub}</p>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {!isEditing && (
            <button onClick={onEdit} style={{
              width: 32, height: 32, borderRadius: 10,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "rgba(255,255,255,0.04)", border: `1px solid ${C.cardBdr}`,
              color: C.sub, cursor: "pointer",
            }}><PencilIcon /></button>
          )}
          {isEditing && (
            <>
              <button onClick={onCancel} disabled={isSaving} style={{
                width: 32, height: 32, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center",
                background: "rgba(255,58,58,0.1)", border: "1px solid rgba(255,58,58,0.22)",
                color: C.red, cursor: "pointer", opacity: isSaving ? 0.5 : 1,
              }}><XIcon /></button>
              <button onClick={onSave} disabled={isSaving} style={{
                width: 32, height: 32, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center",
                background: accentDim, border: `1px solid ${accentBdr}`,
                color: accent, cursor: "pointer", opacity: isSaving ? 0.6 : 1,
              }}>
                {isSaving ? (
                  <motion.div animate={{ rotate: 360 }} transition={{ duration: 0.6, repeat: Infinity, ease: "linear" }}
                    style={{ width: 13, height: 13, borderRadius: "50%", border: "2px solid transparent", borderTopColor: accent }}
                  />
                ) : <CheckIcon />}
              </button>
            </>
          )}
        </div>
      </div>
      <AnimatePresence>
        {isEditing && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            style={{ overflow: "hidden" }}
          >
            <div style={{
              margin: "0 16px 14px", padding: "10px 12px", borderRadius: 10,
              background: "rgba(0,0,0,0.45)", border: `1px solid ${accent}2e`,
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
//  OandaRiskSlider — 0.5% to 10%, default 1%
//  Conservative FX range. Thumb uses var(--accent) for live mode-follow.
// ─────────────────────────────────────────────────────────────────────────────
function OandaRiskSlider({ value, onChange }) {
  const { accent } = useTheme();
  const MIN = 0.5, MAX = 10.0;
  const pct   = ((value - MIN) / (MAX - MIN)) * 100;
  const color = value <= 1.5 ? accent : value <= 3.0 ? C.amber : C.red;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <span style={{ color, fontSize: "1.6rem", fontWeight: 700, fontFamily: FONT_MONO, textShadow: `0 0 10px ${color}55` }}>
          {parseFloat(value).toFixed(1)}%
        </span>
        <span style={{
          fontSize: "0.62rem", fontWeight: 600, letterSpacing: "0.08em",
          padding: "3px 8px", borderRadius: 6,
          background: `${color}12`, border: `1px solid ${color}30`, color, fontFamily: FONT_UI,
        }}>
          {oandaRiskLabel(value)}
        </span>
      </div>
      <div style={{ position: "relative" }}>
        <div style={{
          position: "absolute", top: "50%", left: 0, height: 6, borderRadius: 3, pointerEvents: "none",
          width: `${pct}%`, transform: "translateY(-50%)",
          background: `linear-gradient(90deg, ${accent}, ${color})`,
          boxShadow: `0 0 6px ${color}55`, transition: "width 0.05s, background 0.4s",
        }} />
        <input
          type="range" min={MIN} max={MAX} step="0.5" value={value}
          onChange={e => onChange(parseFloat(e.target.value))}
          style={{
            WebkitAppearance: "none", appearance: "none",
            width: "100%", height: 6, borderRadius: 3,
            background: "rgba(255,255,255,0.06)", outline: "none",
            cursor: "pointer", position: "relative", zIndex: 1,
          }}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.58rem", color: C.sub, fontFamily: FONT_MONO }}>
        <span>0.5%</span><span>2.5%</span><span>5%</span><span>7.5%</span><span>10%</span>
      </div>
      <div style={{
        padding: "8px 10px", borderRadius: 8,
        background: "rgba(0,0,0,0.35)", border: `1px solid ${C.cardBdr}`,
        color: C.sub, fontSize: "0.68rem", lineHeight: 1.5,
      }}>
        Each Oanda trade risks {parseFloat(value).toFixed(1)}% of NAV.
        At $10,000 that is ${(10000 * value / 100).toFixed(0)} per signal.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  BybitRiskSlider — 5% to 50%, default 20%
//  Higher range for small crypto accounts where $5–$10 minimums demand ≥10%.
// ─────────────────────────────────────────────────────────────────────────────
function BybitRiskSlider({ value, onChange }) {
  const { accent } = useTheme();
  const MIN = 5, MAX = 50;
  const pct   = ((value - MIN) / (MAX - MIN)) * 100;
  const color = value <= 20 ? accent : value <= 35 ? C.amber : C.red;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <span style={{ color, fontSize: "1.6rem", fontWeight: 700, fontFamily: FONT_MONO, textShadow: `0 0 10px ${color}55` }}>
          {parseFloat(value).toFixed(0)}%
        </span>
        <span style={{
          fontSize: "0.62rem", fontWeight: 600, letterSpacing: "0.08em",
          padding: "3px 8px", borderRadius: 6,
          background: `${color}12`, border: `1px solid ${color}30`, color, fontFamily: FONT_UI,
        }}>
          {bybitRiskLabel(value)}
        </span>
      </div>
      <div style={{ position: "relative" }}>
        <div style={{
          position: "absolute", top: "50%", left: 0, height: 6, borderRadius: 3, pointerEvents: "none",
          width: `${pct}%`, transform: "translateY(-50%)",
          background: `linear-gradient(90deg, ${accent}, ${color})`,
          boxShadow: `0 0 6px ${color}55`, transition: "width 0.05s, background 0.4s",
        }} />
        <input
          type="range" min={MIN} max={MAX} step="5" value={value}
          onChange={e => onChange(parseFloat(e.target.value))}
          style={{
            WebkitAppearance: "none", appearance: "none",
            width: "100%", height: 6, borderRadius: 3,
            background: "rgba(255,255,255,0.06)", outline: "none",
            cursor: "pointer", position: "relative", zIndex: 1,
          }}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.58rem", color: C.sub, fontFamily: FONT_MONO }}>
        <span>5%</span><span>15%</span><span>25%</span><span>35%</span><span>50%</span>
      </div>
      <div style={{
        padding: "8px 10px", borderRadius: 8,
        background: "rgba(0,0,0,0.35)", border: `1px solid ${C.cardBdr}`,
        color: C.sub, fontSize: "0.68rem", lineHeight: 1.5,
      }}>
        Each Bybit trade risks {parseFloat(value).toFixed(0)}% of available balance.
        At $500 that is ${(500 * value / 100).toFixed(0)} per signal.
      </div>
    </div>
  );
}

// ── Risk label helpers ────────────────────────────────────────────────────────
function oandaRiskLabel(pct) {
  if (pct <= 1.0) return "Conservative";
  if (pct <= 2.0) return "Standard";
  if (pct <= 4.0) return "Aggressive";
  return "High Risk";
}

function bybitRiskLabel(pct) {
  if (pct <= 15) return "Cautious";
  if (pct <= 25) return "Standard";
  if (pct <= 35) return "Aggressive";
  return "Max Risk";
}