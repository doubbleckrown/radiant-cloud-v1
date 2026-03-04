"""app/routes/routes_signals.py — Signal history + trade lock endpoints."""
from __future__ import annotations
import time
from fastapi import APIRouter, Depends, HTTPException
from app.core.auth import get_current_user
from app.core.config import BYBIT_SYMBOLS, TRADE_LOCK_TTL_SECONDS
from app.core.trade_tracker import trade_tracker
import app.core.state as state

router = APIRouter()


@router.get("/api/signals")
async def get_signals(_: dict = Depends(get_current_user)):
    """All Oanda signals (active + history). Sorted newest-first."""
    all_sigs = []
    for sigs in state.signal_history.values():
        all_sigs.extend(sigs)
    return sorted(all_sigs, key=lambda s: s["timestamp"], reverse=True)[:100]


@router.get("/api/bybit/signals")
async def bybit_signals(_: dict = Depends(get_current_user)):
    """All Bybit signals (active + history). Sorted newest-first."""
    all_sigs = []
    for sigs in state.bybit_signal_history.values():
        all_sigs.extend(sigs)
    return sorted(all_sigs, key=lambda s: s["timestamp"], reverse=True)[:100]


@router.get("/api/bybit/trade-locks")
async def get_trade_locks(_: dict = Depends(get_current_user)):
    now   = time.time()
    locks = trade_tracker.all_locks()
    return {
        sym: {
            **lock,
            "age_seconds":     int(now - float(lock.get("opened_at", now))),
            "ttl_remaining_s": max(0, int(float(lock.get("expires_at", now)) - now)),
            "ttl_pct":         round(min(100, (now - float(lock.get("opened_at", now))) / TRADE_LOCK_TTL_SECONDS * 100), 1),
        }
        for sym, lock in locks.items()
    }


@router.delete("/api/bybit/trade-locks/{symbol}")
async def release_trade_lock(symbol: str, _: dict = Depends(get_current_user)):
    if symbol not in BYBIT_SYMBOLS:
        raise HTTPException(404, f"Symbol '{symbol}' not tracked")
    trade_tracker.unlock(symbol)
    return {"unlocked": True, "symbol": symbol}
