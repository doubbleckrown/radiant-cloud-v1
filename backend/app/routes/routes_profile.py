"""
app/routes/routes_profile.py — User Vault profile read/write + auth/me.
Uses Clerk JWT sub to identify the user — fixes the "Sync Failed" issue.
"""
from __future__ import annotations
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core.auth import get_current_user
from app.core.config import BYBIT_DEFAULT_LEVERAGE, BYBIT_MARGIN_TYPE, get_oanda_creds, get_bybit_creds
from app.database.user_vault import load_profile, save_profile
from app.core.trade_tracker import trade_tracker
import app.core.state as state

router = APIRouter()


@router.get("/api/auth/me")
async def me(payload: dict = Depends(get_current_user)):
    clerk_id = payload["sub"]
    profile  = load_profile(clerk_id)
    return {
        "bot_mode":          "PRIVATE",
        "clerk_id":          clerk_id,
        "oanda_connected":   bool(get_oanda_creds()),
        "bybit_connected":   bool(get_bybit_creds()),
        "oanda_instruments": len(state.candle_cache),
        "bybit_symbols":     len(state.bybit_candle_cache),
        "trade_locks":       len(trade_tracker.all_locks()),
        "profile":           profile,
    }


class ProfileUpdateRequest(BaseModel):
    oanda_risk_pct: float | None = None
    bybit_risk_pct: float | None = None
    bot_enabled:    bool  | None = None
    ttl_minutes:    int   | None = None


@router.get("/api/profile")
async def get_profile(payload: dict = Depends(get_current_user)):
    """Return the full Clerk-linked profile for the authenticated user."""
    return load_profile(payload["sub"])


@router.post("/api/profile/update")
async def update_profile(body: ProfileUpdateRequest, payload: dict = Depends(get_current_user)):
    """
    Update one or more profile fields for the authenticated Clerk user.
    Changes are persisted to disk immediately and survive server restarts.
    """
    clerk_id = payload["sub"]
    updates  = {k: v for k, v in body.dict().items() if v is not None}
    if not updates:
        return {"ok": True, "changed": {}, "profile": load_profile(clerk_id)}
    updated = save_profile(clerk_id, updates)
    return {"ok": True, "changed": updates, "profile": updated}


# Legacy compat — old frontend uses /api/settings
@router.get("/api/settings")
async def get_settings_compat(payload: dict = Depends(get_current_user)):
    p = load_profile(payload["sub"])
    return {
        "risk_pct":          p["oanda_risk_pct"],
        "oanda_risk_pct":    p["oanda_risk_pct"],
        "bybit_risk_pct":    p["bybit_risk_pct"],
        "bot_enabled":       p["bot_enabled"],
        "ttl_minutes":       p["ttl_minutes"],
        "rr_ratio":          3.0,
        "bybit_leverage":    BYBIT_DEFAULT_LEVERAGE,
        "bybit_margin_type": BYBIT_MARGIN_TYPE,
    }


class LegacySettingsRequest(BaseModel):
    risk_pct: float | None = None


@router.post("/api/settings/update")
async def update_settings_compat(body: LegacySettingsRequest, payload: dict = Depends(get_current_user)):
    clerk_id = payload["sub"]
    updates: dict = {}
    if body.risk_pct is not None:
        updates["oanda_risk_pct"] = body.risk_pct
        updates["bybit_risk_pct"] = body.risk_pct
    updated = save_profile(clerk_id, updates) if updates else load_profile(clerk_id)
    return {"ok": True, "changed": updates, "risk_pct": updated["oanda_risk_pct"], "profile": updated}
