"""
FX Radiant — Signal & Market Models
======================================
Pydantic schemas for trade signals, SMC analysis state,
candle data, and market snapshots.

These models validate and document every piece of data that flows
through the REST API and WebSocket feed.
"""

from __future__ import annotations
from typing import Literal, Optional
from pydantic import BaseModel, Field


# ── Candle (OHLCV) ────────────────────────────────────────────────────────────

class CandleSchema(BaseModel):
    """A single OHLCV candle as returned by GET /api/markets/{instrument}/candles"""
    t: int    = Field(description="Unix timestamp (seconds)")
    o: float  = Field(description="Open price")
    h: float  = Field(description="High price")
    l: float  = Field(description="Low price")
    c: float  = Field(description="Close price")
    v: float  = Field(default=0.0, description="Volume")


# ── SMC Layer states ──────────────────────────────────────────────────────────

class Layer1State(BaseModel):
    """200 EMA trend filter result."""
    active: bool
    bias:   Literal["BULLISH", "BEARISH", "NEUTRAL"]


class Layer2State(BaseModel):
    """Order Block / FVG detection result."""
    active: bool
    zone:   Optional[str] = Field(
        default=None,
        description="Human-readable zone description e.g. 'OB BULLISH [1.0820 – 1.0834]'"
    )


class Layer3State(BaseModel):
    """Market Structure Shift confirmation result."""
    mss: bool = Field(description="True when candle body closes beyond swing point")


class AnalysisResponse(BaseModel):
    """
    Full 3-layer SMC analysis for one instrument.
    Returned by GET /api/markets/{instrument}/analysis
    """
    instrument:  str
    price:       float
    confidence:  int = Field(ge=0, le=100, description="0, 34, 67, or 100")
    layer1:      Layer1State
    layer2:      Layer2State
    layer3:      Layer3State


# ── Trade Signal ──────────────────────────────────────────────────────────────

class TradeSignalSchema(BaseModel):
    """
    A fully confirmed 100%-confluence SMC trade signal.
    Broadcast over WebSocket AND stored in signal history.
    """
    type:        Literal["SIGNAL"] = "SIGNAL"
    instrument:  str
    direction:   Literal["LONG", "SHORT"]
    entry:       float = Field(description="Entry price at signal time")
    sl:          float = Field(description="Dynamic stop-loss beyond SMC swing")
    tp:          float = Field(description="Take-profit at default RR ratio")
    breakeven:   float = Field(description="1:1 breakeven level")
    rr:          float = Field(description="Actual risk-reward ratio")
    confidence:  int   = Field(default=100)
    layer1:      str   = Field(description="EMA bias: BULLISH or BEARISH")
    layer2:      str   = Field(description="Zone label")
    layer3:      bool  = Field(description="MSS confirmed")
    timestamp:   int   = Field(description="Unix timestamp when signal fired")


# ── Market list item ──────────────────────────────────────────────────────────

class MarketItem(BaseModel):
    """
    One row in the Markets list page.
    Returned by GET /api/markets
    """
    instrument: str
    price:      float
    confidence: int = Field(ge=0, le=100)
    bias:       Literal["BULLISH", "BEARISH", "NEUTRAL"]


# ── WebSocket message types ───────────────────────────────────────────────────

class TickMessage(BaseModel):
    """Real-time price tick broadcast over WebSocket."""
    type:       Literal["TICK"] = "TICK"
    instrument: str
    bid:        float
    ask:        float
    mid:        float
    time:       str   = Field(description="ISO-8601 timestamp string from Oanda")


class SnapshotMessage(BaseModel):
    """
    Initial data burst sent to a client immediately after
    WebSocket connection is established.
    """
    type:    Literal["SNAPSHOT"] = "SNAPSHOT"
    prices:  dict[str, float]
    signals: dict[str, list]   = Field(description="Last 5 signals per instrument")