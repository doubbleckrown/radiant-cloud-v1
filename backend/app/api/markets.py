"""
FX Radiant — Markets Router
=============================
All market data endpoints:

    GET  /api/markets                          → List all instruments with live price + SMC confidence
    GET  /api/markets/{instrument}/candles     → Historical OHLCV candles (M5 / M15 / H1)
    GET  /api/markets/{instrument}/analysis    → Full 3-layer SMC analysis state
    GET  /api/markets/{instrument}/price       → Current mid price only

All routes require a valid JWT (via get_current_user dependency).
"""

from __future__ import annotations
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.database import candle_cache, latest_prices, smc_engines
from app.core.security import get_current_user
from app.models.signal import (
    AnalysisResponse,
    CandleSchema,
    Layer1State,
    Layer2State,
    Layer3State,
    MarketItem,
)

router = APIRouter(prefix="/markets", tags=["Markets"])

# Allowed granularities — anything else gets a 422 validation error
Granularity = Literal["M5", "M15", "H1"]


# ── Market list ───────────────────────────────────────────────────────────────

@router.get(
    "",
    response_model=list[MarketItem],
    summary="Get all instruments with live price and SMC confidence",
)
async def get_markets(
    _: dict = Depends(get_current_user),
) -> list[MarketItem]:
    """
    Returns one row per instrument for the Markets list screen.
    Each row contains:
      • The latest mid-price from the Oanda stream
      • The current SMC confluence confidence (0, 34, 67, or 100)
      • The Layer 1 EMA trend bias (BULLISH / BEARISH / NEUTRAL)
    """
    result = []
    for instrument, engine in smc_engines.items():
        price = latest_prices.get(instrument, 0.0)
        h1_candles = candle_cache[instrument]["H1"]

        if price and len(h1_candles) >= 210:
            state = engine.get_partial_state(h1_candles, price)
            confidence = state.confidence
            bias       = state.layer1_bias.value
        else:
            confidence = 0
            bias       = "NEUTRAL"

        result.append(MarketItem(
            instrument=instrument,
            price=price,
            confidence=confidence,
            bias=bias,
        ))

    return result


# ── Candles ───────────────────────────────────────────────────────────────────

@router.get(
    "/{instrument}/candles",
    response_model=list[CandleSchema],
    summary="Get historical OHLCV candles for an instrument",
)
async def get_candles(
    instrument:  str,
    granularity: Granularity = Query(default="H1", description="M5, M15, or H1"),
    limit:       int         = Query(default=500, ge=10, le=1000),
    _: dict = Depends(get_current_user),
) -> list[CandleSchema]:
    """
    Returns up to `limit` OHLCV candles from the local cache.
    The cache is refreshed every 60 seconds by the background task in main.py.

    Raises 404 if the instrument is not in the supported list.
    """
    if instrument not in candle_cache:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Instrument '{instrument}' is not supported. "
                   f"Supported: {list(candle_cache.keys())}",
        )

    candles = candle_cache[instrument].get(granularity, [])
    return [
        CandleSchema(t=c.time, o=c.open, h=c.high, l=c.low, c=c.close, v=c.volume)
        for c in candles[-limit:]
    ]


# ── Full analysis ─────────────────────────────────────────────────────────────

@router.get(
    "/{instrument}/analysis",
    response_model=AnalysisResponse,
    summary="Get the full 3-layer SMC analysis for an instrument",
)
async def get_analysis(
    instrument: str,
    _: dict = Depends(get_current_user),
) -> AnalysisResponse:
    """
    Returns the current state of all 3 SMC layers for one instrument.
    This powers the 'Analysis Drawer' in the detail view.

      Layer 1: Is price above or below the 200 EMA with hysteresis?
      Layer 2: Is price currently inside an unmitigated OB or FVG?
      Layer 3: Has a candle body closed above/below a swing point (MSS)?

    Confidence levels:
      0  = Layer 1 not active (ranging market)
      34 = Layer 1 confirmed, layers 2 + 3 pending
      67 = Layers 1 + 2 confirmed, layer 3 pending
      100= All 3 layers confirmed → signal has fired
    """
    if instrument not in smc_engines:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Instrument '{instrument}' not found",
        )

    price      = latest_prices.get(instrument, 0.0)
    h1_candles = candle_cache[instrument]["H1"]

    if not price or len(h1_candles) < 210:
        # Not enough data yet — return a neutral state
        return AnalysisResponse(
            instrument=instrument,
            price=price,
            confidence=0,
            layer1=Layer1State(active=False, bias="NEUTRAL"),
            layer2=Layer2State(active=False, zone=None),
            layer3=Layer3State(mss=False),
        )

    state = smc_engines[instrument].get_partial_state(h1_candles, price)

    return AnalysisResponse(
        instrument=instrument,
        price=price,
        confidence=state.confidence,
        layer1=Layer1State(
            active=state.layer1_bias.value != "NEUTRAL",
            bias=state.layer1_bias.value,
        ),
        layer2=Layer2State(
            active=state.layer2_active,
            zone=str(state.layer2_zone) if state.layer2_zone else None,
        ),
        layer3=Layer3State(mss=state.layer3_mss),
    )


# ── Live price ────────────────────────────────────────────────────────────────

@router.get(
    "/{instrument}/price",
    summary="Get the current mid-price for a single instrument",
)
async def get_price(
    instrument: str,
    _: dict = Depends(get_current_user),
) -> dict:
    """
    Lightweight endpoint for fetching just the latest price.
    Useful for polling when a WebSocket connection is not available.
    """
    if instrument not in latest_prices:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No price data yet for '{instrument}'",
        )
    return {"instrument": instrument, "price": latest_prices[instrument]}