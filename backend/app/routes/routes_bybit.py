"""fx-signal — Bybit REST routes"""
from __future__ import annotations
import asyncio
import time
from fastapi import APIRouter, Depends, HTTPException
from app.core.auth import get_current_user
from app.core.config import BYBIT_SYMBOLS, BYBIT_INTERVALS, TRADE_LOCK_TTL_SECONDS, get_bybit_creds
from app.core.state import (
    bybit_candle_cache, bybit_prices, bybit_meta,
    bybit_signal_history, bybit_engines,
)
from app.core.trade_tracker import trade_tracker
from app.engines.bybit.executor import fetch_account, fetch_positions, fetch_trade_history
from app.engines.bybit.engine import _fetch_candles

router = APIRouter(prefix="/api/bybit", tags=["bybit"])


@router.get("/market")
async def bybit_market(_: dict = Depends(get_current_user)):
    result = []
    for sym in BYBIT_SYMBOLS:
        price = bybit_prices.get(sym, 0.0)
        h1    = bybit_candle_cache[sym]["60"]
        meta  = bybit_meta.get(sym, {})
        state = bybit_engines[sym].get_partial_state(h1, price) if (price and len(h1) >= 60) else None
        result.append({
            "symbol":     sym,
            "price":      price,
            "confidence": state.confidence        if state else 0,
            "bias":       state.layer1_bias.value if state else "NEUTRAL",
            "layer2":     state.layer2_active     if state else False,
            "layer3":     state.layer3_mss        if state else False,
            "high24h":    meta.get("high24h",   0.0),
            "low24h":     meta.get("low24h",    0.0),
            "volume24h":  meta.get("volume24h", 0.0),
            "change24h":  round(meta.get("change24h", 0.0), 2),
        })
    result.sort(key=lambda x: x["volume24h"], reverse=True)
    return result


@router.get("/candles/{symbol}")
async def bybit_candles(
    symbol:   str,
    interval: str = "60",
    limit:    int = 120,
    _: dict = Depends(get_current_user),
):
    if symbol not in bybit_candle_cache:
        raise HTTPException(404, f"Symbol '{symbol}' not tracked")
    if interval not in BYBIT_INTERVALS:
        raise HTTPException(400, f"interval must be one of {BYBIT_INTERVALS}")
    n       = max(1, min(limit, 500))
    candles = bybit_candle_cache[symbol].get(interval, [])
    if not candles:
        try:
            candles = await asyncio.wait_for(_fetch_candles(symbol, interval, limit=200), timeout=15.0)
            bybit_candle_cache[symbol][interval] = candles
        except Exception as exc:
            return []
    return [{"t": c.time, "o": c.open, "h": c.high, "l": c.low, "c": c.close, "v": c.volume} for c in candles[-n:]]


@router.get("/signals")
async def bybit_signals(_: dict = Depends(get_current_user)):
    all_sigs = []
    for s in bybit_signal_history.values():
        all_sigs.extend(s)
    return sorted(all_sigs, key=lambda s: s["timestamp"], reverse=True)[:100]


@router.get("/trade-locks")
async def get_trade_locks(_: dict = Depends(get_current_user)):
    now      = time.time()
    locks    = trade_tracker.all_locks()
    enriched = {}
    for sym, lock in locks.items():
        opened  = float(lock.get("opened_at", now))
        expires = float(lock.get("expires_at", now + TRADE_LOCK_TTL_SECONDS))
        enriched[sym] = {
            **lock,
            "age_seconds":     int(now - opened),
            "ttl_remaining_s": max(0, int(expires - now)),
            "ttl_pct":         round(min(100, (now - opened) / TRADE_LOCK_TTL_SECONDS * 100), 1),
        }
    return enriched


@router.delete("/trade-locks/{symbol}")
async def release_lock(symbol: str, _: dict = Depends(get_current_user)):
    if symbol not in BYBIT_SYMBOLS:
        raise HTTPException(404, f"Symbol '{symbol}' not tracked")
    trade_tracker.unlock(symbol)
    return {"unlocked": True, "symbol": symbol}


@router.get("/account")
async def bybit_account(payload: dict = Depends(get_current_user)):
    creds = get_bybit_creds()
    if not creds:
        raise HTTPException(422, "No Bybit credentials — add BYBIT_API_KEY/SECRET to .env")
    try:
        return await fetch_account(*creds)
    except RuntimeError as exc:
        raise HTTPException(503, detail={"error": "Bybit API Unavailable", "detail": str(exc)})
    except Exception as exc:
        raise HTTPException(503, detail={"error": "Bybit API Unavailable", "detail": str(exc)})


@router.get("/account/positions")
async def bybit_positions(_: dict = Depends(get_current_user)):
    creds = get_bybit_creds()
    if not creds:
        raise HTTPException(422, "No Bybit credentials")
    try:
        return await fetch_positions(*creds)
    except RuntimeError as exc:
        raise HTTPException(503, detail={"error": "Bybit API Unavailable", "detail": str(exc)})
    except Exception as exc:
        raise HTTPException(503, detail={"error": "Bybit API Unavailable", "detail": str(exc)})


@router.get("/account/history")
async def bybit_history(payload: dict = Depends(get_current_user), limit: int = 50):
    creds = get_bybit_creds()
    if not creds:
        raise HTTPException(422, "No Bybit credentials")
    try:
        return await fetch_trade_history(*creds, limit=min(limit, 100))
    except RuntimeError as exc:
        raise HTTPException(503, detail={"error": "Bybit API Unavailable", "detail": str(exc)})
    except Exception as exc:
        raise HTTPException(503, detail={"error": "Bybit API Unavailable", "detail": str(exc)})
