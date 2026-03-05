"""
app/database/user_vault.py
==========================
Clerk-linked User Vault.  Each user gets a JSON file keyed by their Clerk sub.

Profile schema
--------------
{
  "oanda_risk_pct":  10.0,    # 1.0 – 20.0
  "bybit_risk_pct":  10.0,    # 1.0 – 20.0  (independent slider)
  "bot_enabled":     true,    # global on/off toggle
  "ttl_minutes":     120,     # default 2 h hard kill
}

All keys are optional — defaults are applied on read if absent.
Atomic write (tmp → rename) prevents corrupt files on crash.
Clerk ID is sanitised to strip any path traversal characters.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger("fx-signal")

# Storage directory — sits next to the app package
_VAULT_DIR = Path(__file__).resolve().parents[2] / "user_vault"
_VAULT_DIR.mkdir(parents=True, exist_ok=True)

# Per-key defaults
_DEFAULTS: dict = {
    # Oanda: conservative FX account — 1% per trade is the industry standard.
    # A $10,000 account risks $100 per signal, fully sized by pip-value formula.
    "oanda_risk_pct": 1.0,
    # Bybit: aggressive crypto account — 20% per trade because crypto accounts
    # are typically much smaller (e.g. $200–$500) and need higher % per trade
    # to produce meaningful position sizes above the exchange minimum.
    "bybit_risk_pct": 20.0,
    "bot_enabled":    True,
    "ttl_minutes":    120,
}


def _vault_path(clerk_id: str) -> Path:
    """Sanitise Clerk ID and return the profile file path."""
    safe = clerk_id.replace("/", "").replace("\\", "").replace("..", "").strip()
    if not safe:
        raise ValueError("clerk_id must not be empty")
    return _VAULT_DIR / f"{safe}.json"


def load_profile(clerk_id: str) -> dict:
    """
    Load the user's profile from disk.
    Returns a fully-populated dict with defaults for any missing keys.
    Never raises — returns defaults on any disk/parse error.
    """
    path = _vault_path(clerk_id)
    raw: dict = {}
    try:
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                raw = json.load(f)
    except Exception as exc:
        logger.warning("UserVault load failed for %s: %s", clerk_id[:12], exc)
    # Merge with defaults — missing keys take the default value
    return {k: raw.get(k, v) for k, v in _DEFAULTS.items()}


def save_profile(clerk_id: str, data: dict) -> dict:
    """
    Atomically save (merge) the supplied fields into the user's profile.
    Returns the updated full profile.
    Raises ValueError for out-of-range values.
    """
    path    = _vault_path(clerk_id)
    current = load_profile(clerk_id)

    # Validate + clamp incoming fields
    if "oanda_risk_pct" in data:
        # Oanda range: 0.5% – 10.0%  (forex capital management)
        current["oanda_risk_pct"] = max(0.5, min(10.0, float(data["oanda_risk_pct"])))
    if "bybit_risk_pct" in data:
        # Bybit range: 5.0% – 50.0%  (crypto with small capital base)
        current["bybit_risk_pct"] = max(5.0, min(50.0, float(data["bybit_risk_pct"])))
    if "bot_enabled" in data:
        current["bot_enabled"] = bool(data["bot_enabled"])
    if "ttl_minutes" in data:
        current["ttl_minutes"] = max(15, min(480, int(data["ttl_minutes"])))

    # Atomic write
    try:
        tmp = path.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(current, f, indent=2)
        tmp.replace(path)
        logger.debug("UserVault saved for %s: %s", clerk_id[:12], current)
    except Exception as exc:
        logger.warning("UserVault save failed for %s: %s", clerk_id[:12], exc)

    return current


def get_risk_pct(clerk_id: str, engine: str = "oanda") -> float:
    """
    Convenience — return the fractional risk (0–1) for the given engine.
    engine: 'oanda' | 'bybit'
    """
    profile = load_profile(clerk_id)
    key     = "bybit_risk_pct" if engine == "bybit" else "oanda_risk_pct"
    return profile[key] / 100.0


def bot_enabled(clerk_id: str) -> bool:
    return load_profile(clerk_id)["bot_enabled"]


def ttl_seconds(clerk_id: str) -> int:
    return load_profile(clerk_id)["ttl_minutes"] * 60