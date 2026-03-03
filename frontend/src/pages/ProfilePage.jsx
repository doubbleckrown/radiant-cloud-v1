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
import api                                    from "../utils/api";
import { useAuthStore }                       from "../store/authStore";
import { useTheme }                           from "../hooks/useTheme";
import { useUser, useClerk }                  from "@clerk/clerk-react";

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
  // Private Bot Mode: authStore only exposes appMode — no credentials or settings
  const { toggleAppMode }   = useAuthStore();
  const { isCrypto, accent, accentDim, accentBdr } = useTheme();

  // Ensure range-thumb CSS is injected once
  useEffect(() => { ensureRangeStyles(); }, []);

  const displayName = clerkUser?.firstName
    ? `${clerkUser.firstName}${clerkUser.lastName ? " " + clerkUser.lastName : ""}`.trim()
    : (clerkUser?.username ?? "Trader");

  const user = {
    name:  displayName,
    email: clerkUser?.primaryEmailAddress?.emailAddress ?? "",
  };

  // ── Editing state ─────────────────────────────────────────────────────────
  const [editing,   setEditing]   = useState(null);
  const [draftName, setDraftName] = useState("");
  // Risk slider — live synced to backend via POST /api/settings/update
  const [draftRisk,    setDraftRisk]    = useState(10.0);  // default 10%
  const [riskSyncing,  setRiskSyncing]  = useState(false);
  const [riskSynced,   setRiskSynced]   = useState(false);
  const [riskError,    setRiskError]    = useState(null);
  const [saving,    setSaving]    = useState(null);
  const [saveError, setSaveError] = useState(null);

  // Load effective risk from backend on mount
  useEffect(() => {
    api.get("/health").then(({ data }) => {
      if (data?.effective_risk_pct != null) {
        setDraftRisk(parseFloat(data.effective_risk_pct));
      }
    }).catch(() => {});
  }, []);

  // Debounced risk sync to backend
  useEffect(() => {
    const t = setTimeout(async () => {
      setRiskSyncing(true);
      setRiskError(null);
      try {
        await api.post("/settings/update", { risk_pct: parseFloat(draftRisk) });
        setRiskSynced(true);
        setTimeout(() => setRiskSynced(false), 2000);
      } catch (e) {
        setRiskError("Sync failed");
      } finally {
        setRiskSyncing(false);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [draftRisk]);

  const openEdit = useCallback((field) => {
    setSaveError(null);
    if (field === "name") setDraftName(user.name);
    setEditing(field);
  }, [user]);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setSaveError(null);
  }, []);

  const commit = useCallback(async (field) => {
    if (field === "risk") { setEditing(null); return; } // risk auto-syncs via useEffect
    setSaving(field);
    setSaveError(null);
    try {
      // Only name edit supported via Clerk — no backend settings call needed for name
      setEditing(null);
    } catch (err) {
      setSaveError(err?.response?.data?.detail ?? "Save failed — try again");
    } finally {
      setSaving(null);
    }
  }, []);

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

        {/* ── Bot Status (replaces credential forms in Private Bot Mode) ──── */}
        <BotStatusSection isCrypto={isCrypto} accent={accent} accentDim={accentDim} accentBdr={accentBdr} />

        {/* ── Risk Settings ────────────────────────────────────────────────── */}
        <Section label="Risk Settings">
          <div style={{ padding: "4px 0" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div>
                <p style={{ color: C.white, fontSize: "0.85rem", fontWeight: 600, margin: 0 }}>
                  Risk Per Trade
                </p>
                <p style={{ color: C.sub, fontSize: "0.7rem", margin: "3px 0 0" }}>
                  % of account equity per auto-executed signal
                </p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{
                  fontFamily: FONT_MONO, fontSize: "1.1rem", fontWeight: 700,
                  color: accent,
                  textShadow: `0 0 10px ${accent}80`,
                }}>
                  {parseFloat(draftRisk).toFixed(1)}%
                </span>
                {riskSyncing && (
                  <span style={{ fontSize: "0.6rem", color: C.sub }}>syncing…</span>
                )}
                {riskSynced && !riskSyncing && (
                  <span style={{ fontSize: "0.6rem", color: C.green }}>✓ saved</span>
                )}
                {riskError && (
                  <span style={{ fontSize: "0.6rem", color: C.red }}>{riskError}</span>
                )}
              </div>
            </div>
            <RiskSlider value={draftRisk} onChange={setDraftRisk} accent={accent} />
            <p style={{ color: C.sub, fontSize: "0.65rem", marginTop: 8 }}>
              Each trade risks {parseFloat(draftRisk).toFixed(1)}% of account equity.
              Changes sync to the bot immediately — no restart required.
            </p>
          </div>
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
// ─────────────────────────────────────────────────────────────────────────────
//  BotStatusSection — Private Bot Mode
// ─────────────────────────────────────────────────────────────────────────────
function BotStatusSection({ isCrypto, accent }) {
  const [status, setStatus] = useState(null);
  const BYBIT_ORANGE = "#FFA500";
  const engineColor  = isCrypto ? BYBIT_ORANGE : accent;

  useEffect(() => {
    import("../utils/api").then(({ default: api }) =>
      api.get("/auth/me").then(({ data }) => setStatus(data)).catch(() => {})
    );
  }, []);

  const rows = isCrypto ? [
    {
      icon: "₿", label: "Bybit API",
      ok: status?.bybit_connected ?? false,
      status: status == null ? "CHECKING…" : (status.bybit_connected ? "CONNECTED" : "NOT CONFIGURED"),
      sub: status?.bybit_connected
        ? `${status.bybit_symbols ?? 19} symbols · USDT Perpetuals · Linear`
        : "Set BYBIT_API_KEY + BYBIT_API_SECRET in .env",
    },
    {
      icon: "⚡", label: "Auto-Execute",
      ok: status?.bybit_connected ?? false,
      status: status?.bybit_connected ? "ARMED" : "OFFLINE",
      sub: "Fires Bybit market orders at 100% SMC confluence · 20× Isolated",
    },
  ] : [
    {
      icon: "📈", label: "Oanda API",
      ok: status?.oanda_connected ?? false,
      status: status == null ? "CHECKING…" : (status.oanda_connected ? "CONNECTED" : "NOT CONFIGURED"),
      sub: status?.oanda_connected
        ? `${status.oanda_instruments ?? 16} instruments · v20 REST + WebSocket`
        : "Set OANDA_API_KEY + OANDA_ACCOUNT_ID in .env",
    },
    {
      icon: "⚡", label: "Auto-Execute",
      ok: status?.oanda_connected ?? false,
      status: status?.oanda_connected ? "ARMED" : "OFFLINE",
      sub: "Fires Oanda market orders at 100% SMC confluence · Max Margin",
    },
  ];

  return (
    <div>
      <p style={{
        color: C.sub, fontSize: "0.6rem", fontWeight: 600,
        letterSpacing: "0.12em", textTransform: "uppercase",
        margin: "0 0 8px 4px",
      }}>Bot Status</p>
      <div style={{
        borderRadius: 16, overflow: "hidden", background: C.card,
        border: `1px solid rgba(${isCrypto ? "255,165,0" : "0,255,65"},0.2)`,
      }}>
        {rows.map((row, i) => (
          <div key={row.label} style={{
            display: "flex", alignItems: "center", gap: 14, padding: "14px 16px",
            borderBottom: i < rows.length - 1 ? `1px solid ${C.cardBdr}` : "none",
          }}>
            <div style={{
              width: 40, height: 40, borderRadius: 12, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.1rem",
              background: row.ok ? `${engineColor}10` : "rgba(255,255,255,0.04)",
              border: `1px solid ${row.ok ? `${engineColor}30` : C.cardBdr}`,
            }}>{row.icon}</div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <p style={{ color: C.white, fontSize: "0.88rem", fontWeight: 600, margin: 0 }}>{row.label}</p>
                <span style={{
                  fontSize: "0.55rem", fontWeight: 700, padding: "2px 7px", borderRadius: 5,
                  background: row.ok ? `${engineColor}10` : "rgba(255,58,58,0.1)",
                  border: `1px solid ${row.ok ? `${engineColor}28` : "rgba(255,58,58,0.25)"}`,
                  color: row.ok ? engineColor : C.red, fontFamily: FONT_MONO, letterSpacing: "0.08em",
                }}>{row.status}</span>
              </div>
              <p style={{ color: C.sub, fontSize: "0.67rem", margin: "3px 0 0" }}>{row.sub}</p>
            </div>
          </div>
        ))}
        <div style={{ padding: "12px 16px", borderTop: `1px solid ${C.cardBdr}`, background: "rgba(0,0,0,0.3)" }}>
          <p style={{ color: C.sub, fontSize: "0.65rem", margin: 0, lineHeight: 1.6 }}>
            🔐 Credentials are managed server-side via <span style={{ color: C.label, fontFamily: FONT_MONO, fontSize: "0.6rem" }}>.env</span>.
            No API keys are stored in the browser.
          </p>
        </div>
      </div>
    </div>
  );
}


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
//  RiskSlider — uses var(--accent) for the fill and thumb so it follows mode.
//  The CSS for the range thumb is injected once via ensureRangeStyles() and
//  uses var(--accent) which _persistMode() keeps in sync.
// ═════════════════════════════════════════════════════════════════════════════
//  BybitTradingSettings — CRYPTO mode only
//
//  Renders a card with:
//    • Margin Type toggle  — ISOLATED (default) | CROSS
//    • Leverage slider     — 10× … 50×, default 20×
//    • Auto-Trade status   — read-only summary (toggle lives on SignalsPage)
//
//  All changes POST to PATCH /api/bybit/settings immediately on interaction
//  (no "Save" button needed — each control saves itself).
// ═════════════════════════════════════════════════════════════════════════════
function BybitTradingSettings({ marginType: initMarginType, leverage: initLeverage, autoTrade }) {
  const { accent, accentDim, accentBdr } = useTheme();
  const BYBIT_ORANGE = "#FFA500";
  const clr          = BYBIT_ORANGE;

  const [marginType, setMarginType] = useState(initMarginType ?? "ISOLATED");
  const [leverage,   setLeverage]   = useState(initLeverage   ?? 20);
  const [saving,     setSaving]     = useState(false);
  const [saveMsg,    setSaveMsg]    = useState(null); // null | "ok" | "err"

  // Persist changes to backend
  const persist = async (patch) => {
    setSaving(true);
    setSaveMsg(null);
    try {
      await import("../utils/api").then(({ default: api }) =>
        api.patch("/bybit/settings", patch)
      );
      setSaveMsg("ok");
      setTimeout(() => setSaveMsg(null), 2200);
    } catch {
      setSaveMsg("err");
      setTimeout(() => setSaveMsg(null), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleMarginToggle = async (next) => {
    setMarginType(next);
    await persist({ bybit_margin_type: next });
  };

  const handleLeverageCommit = async () => {
    await persist({ bybit_leverage: leverage });
  };

  // Leverage label
  const levColor = leverage <= 10 ? "#aaaaaa"
                 : leverage <= 20 ? BYBIT_ORANGE
                 : leverage <= 35 ? "#ff8c00"
                 : C.red;
  const levLabel = leverage <= 5  ? "Conservative"
                 : leverage <= 15 ? "Standard"
                 : leverage <= 25 ? "Aggressive"
                 : leverage <= 40 ? "High Risk"
                 :                  "Maximum Risk";

  return (
    <div>
      <p style={{
        color: C.sub, fontSize: "0.6rem", fontWeight: 600,
        letterSpacing: "0.12em", textTransform: "uppercase",
        margin: "0 0 8px 4px", fontFamily: FONT_UI,
      }}>
        Bybit Trading Settings
      </p>

      <motion.div
        animate={{
          border:    `1px solid rgba(255,165,0,0.25)`,
          boxShadow: "0 0 24px rgba(255,165,0,0.07)",
        }}
        transition={{ duration: 0.4 }}
        style={{ borderRadius: 16, overflow: "hidden", background: C.card }}
      >
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "14px 16px",
          borderBottom: `1px solid ${C.cardBdr}`,
        }}>
          <div style={{
            width: 40, height: 40, borderRadius: 12, flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "1.2rem",
            background: "rgba(255,165,0,0.1)",
            border:     "1px solid rgba(255,165,0,0.3)",
          }}>⚙️</div>
          <div style={{ flex: 1 }}>
            <p style={{ color: C.white, fontSize: "0.88rem", fontWeight: 600, margin: "0 0 2px" }}>
              Futures Execution
            </p>
            <p style={{ color: C.sub, fontSize: "0.67rem", margin: 0 }}>
              Applied to all Bybit auto-trade orders
            </p>
          </div>
          {/* Save feedback badge */}
          <AnimatePresence>
            {saveMsg && (
              <motion.span
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                style={{
                  fontSize: "0.6rem", fontWeight: 700, padding: "3px 9px",
                  borderRadius: 6, letterSpacing: "0.08em", fontFamily: FONT_MONO,
                  background: saveMsg === "ok" ? "rgba(0,255,65,0.1)" : "rgba(255,58,58,0.1)",
                  border:     saveMsg === "ok" ? "1px solid rgba(0,255,65,0.3)" : "1px solid rgba(255,58,58,0.3)",
                  color:      saveMsg === "ok" ? "#00FF41" : C.red,
                }}
              >
                {saveMsg === "ok" ? "✓ SAVED" : "✕ ERROR"}
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        {/* ── Margin Type Toggle ──────────────────────────────────────── */}
        <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.cardBdr}` }}>
          <p style={{
            color: C.label, fontSize: "0.62rem", textTransform: "uppercase",
            letterSpacing: "0.1em", margin: "0 0 10px", fontFamily: FONT_UI,
          }}>
            Margin Mode
          </p>
          <div style={{
            display:      "flex",
            background:   "#0a0a0a",
            border:       "1px solid rgba(255,165,0,0.2)",
            borderRadius: 10,
            padding:      2,
            gap:          2,
          }}>
            {["ISOLATED", "CROSS"].map(mode => {
              const isActive = marginType === mode;
              return (
                <button
                  key={mode}
                  onClick={() => !isActive && handleMarginToggle(mode)}
                  disabled={saving}
                  style={{
                    flex:        1,
                    padding:     "9px 0",
                    borderRadius: 8,
                    border:       "none",
                    cursor:       isActive ? "default" : "pointer",
                    background:   isActive ? "rgba(255,165,0,0.18)" : "transparent",
                    boxShadow:    isActive ? "0 0 12px rgba(255,165,0,0.2)" : "none",
                    transition:   "all 0.2s",
                    WebkitTapHighlightColor: "transparent",
                  }}
                >
                  <p style={{
                    color:         isActive ? BYBIT_ORANGE : C.sub,
                    fontSize:      "0.72rem",
                    fontWeight:    isActive ? 700 : 400,
                    letterSpacing: "0.07em",
                    fontFamily:    FONT_MONO,
                    margin:        0,
                    transition:    "color 0.2s",
                  }}>
                    {mode}
                  </p>
                  <p style={{
                    color:    isActive ? `${BYBIT_ORANGE}90` : "#333",
                    fontSize: "0.55rem",
                    margin:   "2px 0 0",
                    fontFamily: FONT_UI,
                  }}>
                    {mode === "ISOLATED" ? "Risk capped per trade" : "Shared account balance"}
                  </p>
                </button>
              );
            })}
          </div>
          {marginType === "CROSS" && (
            <motion.p
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              style={{
                color: C.amber, fontSize: "0.65rem", margin: "8px 0 0",
                padding: "6px 10px", borderRadius: 7,
                background: "rgba(255,184,0,0.06)",
                border: "1px solid rgba(255,184,0,0.2)",
              }}
            >
              ⚠ Cross margin uses your full account balance as collateral. A losing position can liquidate all funds.
            </motion.p>
          )}
        </div>

        {/* ── Leverage Slider ─────────────────────────────────────────── */}
        <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.cardBdr}` }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
            <p style={{
              color: C.label, fontSize: "0.62rem", textTransform: "uppercase",
              letterSpacing: "0.1em", margin: 0, fontFamily: FONT_UI,
            }}>
              Leverage
            </p>
            <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
              <span style={{
                color: levColor, fontSize: "1.5rem", fontWeight: 800,
                fontFamily: FONT_MONO, textShadow: `0 0 12px ${levColor}55`,
                transition: "color 0.2s",
              }}>
                {leverage}×
              </span>
              <span style={{
                fontSize: "0.58rem", fontWeight: 600, padding: "2px 7px", borderRadius: 5,
                background: `${levColor}12`, border: `1px solid ${levColor}30`,
                color: levColor, fontFamily: FONT_UI, letterSpacing: "0.06em",
              }}>
                {levLabel}
              </span>
            </div>
          </div>

          {/* Slider track + fill */}
          <div style={{ position: "relative", marginBottom: 6 }}>
            <div style={{
              position: "absolute", top: "50%", left: 0, height: 6,
              borderRadius: 3, pointerEvents: "none",
              width: `${((leverage - 10) / 40) * 100}%`,
              transform: "translateY(-50%)",
              background: `linear-gradient(90deg, ${BYBIT_ORANGE}80, ${levColor})`,
              boxShadow: `0 0 8px ${levColor}55`,
              transition: "width 0.08s, background 0.3s",
            }} />
            <input
              type="range" min="10" max="50" step="1" value={leverage}
              onChange={e => setLeverage(parseInt(e.target.value))}
              onMouseUp={handleLeverageCommit}
              onTouchEnd={handleLeverageCommit}
              style={{
                WebkitAppearance: "none", appearance: "none",
                width: "100%", height: 6, borderRadius: 3,
                background: "rgba(255,255,255,0.06)", outline: "none",
                cursor: "pointer", position: "relative", zIndex: 1,
              }}
            />
          </div>

          {/* Tick marks */}
          <div style={{
            display: "flex", justifyContent: "space-between",
            fontSize: "0.55rem", color: C.sub, fontFamily: FONT_MONO, marginTop: 4,
          }}>
            {["10×","20×","30×","40×","50×"].map(t => (
              <span key={t} style={{ color: t === `${leverage}×` ? levColor : C.sub }}>{t}</span>
            ))}
          </div>

          {/* Risk info row */}
          <div style={{
            marginTop: 10, padding: "8px 10px", borderRadius: 8,
            background: "rgba(0,0,0,0.35)", border: `1px solid ${C.cardBdr}`,
            color: C.sub, fontSize: "0.67rem", lineHeight: 1.5,
          }}>
            At {leverage}× leverage, a <strong style={{ color: `${levColor}cc` }}>
              {(100 / leverage).toFixed(1)}%
            </strong> adverse move triggers liquidation ({marginType} mode).
            Position size is auto-calculated from your risk % setting.
          </div>
        </div>

        {/* ── Auto-Trade Status (read-only summary) ───────────────────── */}
        <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
            background: autoTrade ? BYBIT_ORANGE : "#444",
            boxShadow: autoTrade ? `0 0 8px ${BYBIT_ORANGE}` : "none",
          }} />
          <p style={{ color: C.sub, fontSize: "0.68rem", margin: 0 }}>
            Auto-Trade is{" "}
            <span style={{ color: autoTrade ? BYBIT_ORANGE : C.label, fontWeight: 700 }}>
              {autoTrade ? "ENABLED" : "DISABLED"}
            </span>
            {" "}— toggle from the{" "}
            <span style={{ color: C.label }}>Signals</span> page.
          </p>
        </div>
      </motion.div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function RiskSlider({ value, onChange, accent: accentProp }) {
  const { accent: themeAccent } = useTheme();
  const accent = accentProp ?? themeAccent;
  const pct   = ((value - 1.0) / (20.0 - 1.0)) * 100;
  const color = value <= 5.0 ? accent : value <= 10.0 ? C.amber : C.red;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ position: "relative" }}>
        <div style={{
          position: "absolute", top: "50%", left: 0, height: 6, borderRadius: 3, pointerEvents: "none",
          width: `${pct}%`, transform: "translateY(-50%)",
          background: `linear-gradient(90deg, ${accent}, ${color})`,
          boxShadow: `0 0 6px ${color}55`, transition: "width 0.05s, background 0.4s",
        }} />
        <input
          type="range" min="1" max="20" step="0.5" value={value}
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
        <span>1%</span><span>5%</span><span>10%</span><span>15%</span><span>20%</span>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function riskLabel(pct) {
  if (pct <= 3.0)  return "Conservative";
  if (pct <= 7.0)  return "Standard";
  if (pct <= 12.0) return "Aggressive";
  return "High Risk";
}