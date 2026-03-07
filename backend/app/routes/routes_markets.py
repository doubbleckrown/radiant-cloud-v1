"""app/routes/routes_markets.py — Market data endpoints (Oanda + Bybit)."""
from __future__ import annotations
import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import get_current_user
from app.core.config import INSTRUMENTS, BYBIT_SYMBOLS, BYBIT_INTERVALS
import app.core.state as state

logger = logging.getLogger("fx-signal")
router = APIRouter()


@router.get("/api/markets")
async def get_markets(_: dict = Depends(get_current_user)):
    result = []
    for ins in INSTRUMENTS:
        price      = state.latest_prices.get(ins, 0.0)
        daily_open = state.oanda_daily_open.get(ins, 0.0)
        h1         = state.candle_cache[ins]["H1"]
        candles_d  = state.candle_cache[ins].get("D", [])
        engine     = state.oanda_engines[ins]
        smc        = engine.get_partial_state(candles_d, h1, price) if len(h1) >= 100 else None
        change24h  = round((price - daily_open) / daily_open * 100, 2) if price > 0 and daily_open > 0 else None
        result.append({
            "instrument": ins, "price": price, "change24h": change24h,
            "confidence":  smc.confidence        if smc else 0,
            "bias":        smc.layer1_bias.value if smc else "NEUTRAL",
            "layer2":      smc.layer2_active     if smc else False,
            "layer3":      smc.layer3_mss        if smc else False,
            "pd_zone":     smc.pd_zone           if smc else None,
            "pd_aligned":  smc.pd_aligned        if smc else False,
            "h1_bars":     len(h1),
            "d_bars":      len(candles_d),
        })
    return result


@router.get("/api/markets/{instrument}/candles")
async def get_candles(instrument: str, granularity: str = "H1", count: int = 120,
                      _: dict = Depends(get_current_user)):
    if instrument not in state.candle_cache:
        raise HTTPException(404, "Instrument not found")
    n = max(1, min(count, 500))
    return [{"t": c.time, "o": c.open, "h": c.high, "l": c.low, "c": c.close, "v": c.volume}
            for c in state.candle_cache[instrument].get(granularity, [])[-n:]]


@router.get("/api/markets/{instrument}/analysis")
async def get_analysis(instrument: str, _: dict = Depends(get_current_user)):
    if instrument not in state.oanda_engines:
        raise HTTPException(404, "Instrument not found")
    price     = state.latest_prices.get(instrument, 0.0)
    h1        = state.candle_cache[instrument]["H1"]
    candles_d = state.candle_cache[instrument].get("D", [])
    smc       = state.oanda_engines[instrument].get_partial_state(candles_d, h1, price) if len(h1) >= 100 else None
    if not smc:
        return {"confidence": 0}
    return {
        "instrument": instrument, "price": price, "confidence": smc.confidence,
        "layer1": {"bias": smc.layer1_bias.value, "active": smc.layer1_bias.value != "NEUTRAL"},
        "layer2": {"active": smc.layer2_active, "zone": str(smc.layer2_zone) if smc.layer2_zone else None},
        "layer3": {"mss": smc.layer3_mss},
    }


@router.get("/api/bybit/market")
async def bybit_market(_: dict = Depends(get_current_user)):
    result = []
    for sym in BYBIT_SYMBOLS:
        price = state.bybit_prices.get(sym, 0.0)
        h1        = state.bybit_candle_cache[sym]["60"]
        candles_4h = state.bybit_candle_cache[sym].get("240", [])
        meta      = state.bybit_meta.get(sym, {})
        smc       = state.bybit_engines[sym].get_partial_state(candles_4h, h1, price) if (price and len(h1) >= 60) else None
        result.append({
            "symbol": sym, "price": price,
            "confidence":  smc.confidence        if smc else 0,
            "bias":        smc.layer1_bias.value if smc else "NEUTRAL",
            "layer2":      smc.layer2_active     if smc else False,
            "layer3":      smc.layer3_mss        if smc else False,
            "pd_zone":     smc.pd_zone           if smc else None,
            "pd_aligned":  smc.pd_aligned        if smc else False,
            # candle counts help the UI distinguish "loading" from "no signal"
            "h1_bars":     len(h1),
            "d_bars":      len(candles_4h),
            "high24h":     meta.get("high24h",   0.0),
            "low24h":      meta.get("low24h",    0.0),
            "volume24h":   meta.get("volume24h", 0.0),
            "change24h":   round(meta.get("change24h", 0.0), 2),
        })
    result.sort(key=lambda x: x["volume24h"], reverse=True)
    return result


@router.get("/api/bybit/candles/{symbol}")
async def bybit_candles(symbol: str, interval: str = "60", limit: int = 120,
                        _: dict = Depends(get_current_user)):
    if symbol not in state.bybit_candle_cache:
        raise HTTPException(404, f"Symbol '{symbol}' not tracked")
    if interval not in BYBIT_INTERVALS:
        raise HTTPException(400, f"interval must be one of {BYBIT_INTERVALS}")
    n = max(1, min(limit, 500))
    candles = state.bybit_candle_cache[symbol].get(interval, [])
    if not candles:
        from app.engines.bybit.engine import fetch_candles as _fetch
        try:
            candles = await asyncio.wait_for(_fetch(symbol, interval), timeout=15.0)
            state.bybit_candle_cache[symbol][interval] = candles
        except Exception as exc:
            logger.warning("Bybit live fetch %s %s: %s", symbol, interval, exc)
            return []
    return [{"t": c.time, "o": c.open, "h": c.high, "l": c.low, "c": c.close, "v": c.volume}
            for c in candles[-n:]]