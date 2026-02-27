"""
FX Radiant — 3-Layer Smart Money Concepts (SMC/ICT) Strategy Engine
============================================================
Layer 1: 200 EMA Trend Filter with 0.01% hysteresis dead-zone
Layer 2: Order Block (OB) & Fair Value Gap (FVG) identification
Layer 3: Market Structure Shift (MSS) — candle body close confirmation
"""

from __future__ import annotations
import numpy as np
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


# ─────────────────────────────────────────────────────────────────────────────
#  Domain Models
# ─────────────────────────────────────────────────────────────────────────────

class Bias(str, Enum):
    BULLISH = "BULLISH"
    BEARISH = "BEARISH"
    NEUTRAL  = "NEUTRAL"


class SignalDirection(str, Enum):
    LONG  = "LONG"
    SHORT = "SHORT"


@dataclass
class Candle:
    time:   int    # unix epoch (seconds)
    open:   float
    high:   float
    low:    float
    close:  float
    volume: float = 0.0

    @property
    def body_high(self) -> float:
        return max(self.open, self.close)

    @property
    def body_low(self) -> float:
        return min(self.open, self.close)

    @property
    def is_bullish(self) -> bool:
        return self.close > self.open

    @property
    def is_bearish(self) -> bool:
        return self.close < self.open


@dataclass
class OrderBlock:
    direction: Bias          # BULLISH or BEARISH
    ob_high:   float
    ob_low:    float
    origin_time: int
    mitigated: bool = False

    def contains(self, price: float) -> bool:
        return self.ob_low <= price <= self.ob_high


@dataclass
class FairValueGap:
    direction: Bias
    gap_high:  float
    gap_low:   float
    origin_time: int
    filled: bool = False

    def contains(self, price: float) -> bool:
        return self.gap_low <= price <= self.gap_high


@dataclass
class SwingPoint:
    price: float
    time:  int
    kind:  str  # "HH", "LH", "HL", "LL"


@dataclass
class ConfirmationState:
    """Tracks whether each layer has confirmed a directional bias."""
    layer1_bias:   Bias = Bias.NEUTRAL
    layer2_active: bool = False
    layer2_zone:   Optional[OrderBlock | FairValueGap] = None
    layer3_mss:    bool = False
    direction:     Optional[SignalDirection] = None

    @property
    def confidence(self) -> int:
        """Returns 0–100 integer confidence score."""
        score = 0
        if self.layer1_bias != Bias.NEUTRAL:
            score += 34
        if self.layer2_active:
            score += 33
        if self.layer3_mss:
            score += 33
        return score

    @property
    def is_full_confluence(self) -> bool:
        return self.confidence == 100


@dataclass
class TradeSignal:
    instrument:  str
    direction:   SignalDirection
    entry_price: float
    stop_loss:   float
    take_profit: float  # 1:2 RR by default
    confidence:  int
    layer1_bias: str
    layer2_zone: str
    layer3_mss:  bool
    timestamp:   int

    @property
    def risk_reward(self) -> float:
        risk   = abs(self.entry_price - self.stop_loss)
        reward = abs(self.take_profit - self.entry_price)
        return round(reward / risk, 2) if risk else 0.0

    @property
    def breakeven_price(self) -> float:
        """1:1 breakeven level."""
        risk = abs(self.entry_price - self.stop_loss)
        if self.direction == SignalDirection.LONG:
            return self.entry_price + risk
        return self.entry_price - risk


# ─────────────────────────────────────────────────────────────────────────────
#  Layer 1 — 200 EMA Trend Filter
# ─────────────────────────────────────────────────────────────────────────────

def calculate_ema(prices: list[float], period: int = 200) -> list[float]:
    """Exponential Moving Average (smoothed, not Wilder's)."""
    if len(prices) < period:
        return []
    k = 2.0 / (period + 1)
    ema = [sum(prices[:period]) / period]
    for price in prices[period:]:
        ema.append(price * k + ema[-1] * (1 - k))
    return ema


def layer1_trend_bias(
    candles: list[Candle],
    ema_period: int = 200,
    hysteresis_pct: float = 0.0001,   # 0.01%
) -> Bias:
    """
    Compare current close to 200 EMA with a ±0.01% dead-zone to
    prevent whipsawing on ranging markets.
    """
    closes = [c.close for c in candles]
    ema_values = calculate_ema(closes, ema_period)
    if not ema_values:
        return Bias.NEUTRAL

    current_close = closes[-1]
    current_ema   = ema_values[-1]
    band          = current_ema * hysteresis_pct

    if current_close > current_ema + band:
        return Bias.BULLISH
    if current_close < current_ema - band:
        return Bias.BEARISH
    return Bias.NEUTRAL


# ─────────────────────────────────────────────────────────────────────────────
#  Layer 2 — Order Block & Fair Value Gap Detection
# ─────────────────────────────────────────────────────────────────────────────

def detect_order_blocks(
    candles: list[Candle],
    lookback: int = 50,
) -> list[OrderBlock]:
    """
    Identify Order Blocks: the last opposing candle before a strong
    impulse move that created a new swing high/low.
    """
    blocks: list[OrderBlock] = []
    candles = candles[-lookback:]

    for i in range(2, len(candles) - 1):
        prev  = candles[i - 1]
        curr  = candles[i]
        nxt   = candles[i + 1]

        # Bullish OB: bearish candle followed by strong bullish impulse
        if (prev.is_bearish and curr.is_bullish
                and curr.close > prev.high              # engulfing close
                and (curr.close - curr.open) > (prev.open - prev.close)):
            blocks.append(OrderBlock(
                direction=Bias.BULLISH,
                ob_high=prev.body_high,
                ob_low=prev.body_low,
                origin_time=prev.time,
            ))

        # Bearish OB: bullish candle followed by strong bearish impulse
        if (prev.is_bullish and curr.is_bearish
                and curr.close < prev.low
                and (curr.open - curr.close) > (prev.close - prev.open)):
            blocks.append(OrderBlock(
                direction=Bias.BEARISH,
                ob_high=prev.body_high,
                ob_low=prev.body_low,
                origin_time=prev.time,
            ))

    return blocks


def detect_fair_value_gaps(
    candles: list[Candle],
    lookback: int = 50,
) -> list[FairValueGap]:
    """
    FVG: 3-candle pattern where candle[i-1].high < candle[i+1].low  (bull)
    or candle[i-1].low > candle[i+1].high  (bear).
    """
    gaps: list[FairValueGap] = []
    candles = candles[-lookback:]

    for i in range(1, len(candles) - 1):
        c1, c2, c3 = candles[i - 1], candles[i], candles[i + 1]

        # Bullish FVG
        if c1.high < c3.low:
            gaps.append(FairValueGap(
                direction=Bias.BULLISH,
                gap_high=c3.low,
                gap_low=c1.high,
                origin_time=c2.time,
            ))

        # Bearish FVG
        if c1.low > c3.high:
            gaps.append(FairValueGap(
                direction=Bias.BEARISH,
                gap_high=c1.low,
                gap_low=c3.high,
                origin_time=c2.time,
            ))

    return gaps


def layer2_value_zone(
    current_price: float,
    candles: list[Candle],
    bias: Bias,
) -> tuple[bool, Optional[OrderBlock | FairValueGap]]:
    """
    Returns (active, zone) if current price is inside an unmitigated OB or FVG
    that aligns with the Layer 1 bias.
    """
    if bias == Bias.NEUTRAL:
        return False, None

    obs  = detect_order_blocks(candles)
    fvgs = detect_fair_value_gaps(candles)

    # Priority: OBs first, then FVGs
    for ob in reversed(obs):
        if ob.direction.value == bias.value and ob.contains(current_price) and not ob.mitigated:
            return True, ob

    for fvg in reversed(fvgs):
        if fvg.direction.value == bias.value and fvg.contains(current_price) and not fvg.filled:
            return True, fvg

    return False, None


# ─────────────────────────────────────────────────────────────────────────────
#  Layer 3 — Market Structure Shift (MSS)
# ─────────────────────────────────────────────────────────────────────────────

def identify_swing_points(
    candles: list[Candle],
    lookback: int = 5,
) -> list[SwingPoint]:
    """Identify swing highs and lows using a rolling lookback window."""
    swings: list[SwingPoint] = []
    if len(candles) < lookback * 2 + 1:
        return swings

    for i in range(lookback, len(candles) - lookback):
        window_highs = [c.high for c in candles[i - lookback: i + lookback + 1]]
        window_lows  = [c.low  for c in candles[i - lookback: i + lookback + 1]]
        c = candles[i]

        if c.high == max(window_highs):
            swings.append(SwingPoint(price=c.high, time=c.time, kind="SH"))
        elif c.low == min(window_lows):
            swings.append(SwingPoint(price=c.low, time=c.time, kind="SL"))

    return swings


def layer3_market_structure_shift(
    candles: list[Candle],
    bias: Bias,
    swing_lookback: int = 5,
) -> tuple[bool, Optional[float]]:
    """
    Bullish MSS: candle BODY closes ABOVE a prior swing high  → structure shift up.
    Bearish MSS: candle BODY closes BELOW a prior swing low   → structure shift down.

    Returns (mss_confirmed, swing_level_used).
    """
    if bias == Bias.NEUTRAL or len(candles) < swing_lookback * 2 + 2:
        return False, None

    swings    = identify_swing_points(candles[:-1], swing_lookback)
    last_body = candles[-1]

    if bias == Bias.BULLISH:
        swing_highs = [s for s in swings if s.kind == "SH"]
        if not swing_highs:
            return False, None
        # Use the most recent swing high as the trigger level
        trigger = swing_highs[-1].price
        if last_body.body_high > trigger:   # body close above, not wick
            return True, trigger

    elif bias == Bias.BEARISH:
        swing_lows = [s for s in swings if s.kind == "SL"]
        if not swing_lows:
            return False, None
        trigger = swing_lows[-1].price
        if last_body.body_low < trigger:
            return True, trigger

    return False, None


# ─────────────────────────────────────────────────────────────────────────────
#  Risk Engine
# ─────────────────────────────────────────────────────────────────────────────

def calculate_dynamic_sl(
    direction: SignalDirection,
    entry: float,
    candles: list[Candle],
    swing_lookback: int = 5,
    sl_buffer_pct: float = 0.0002,   # 0.02% beyond swing
) -> float:
    """Place SL beyond the nearest SMC swing point, not fixed pips."""
    swings = identify_swing_points(candles, swing_lookback)
    buffer = entry * sl_buffer_pct

    if direction == SignalDirection.LONG:
        lows = sorted([s.price for s in swings if s.kind == "SL"], reverse=True)
        sl_level = lows[0] if lows else entry * 0.998
        return sl_level - buffer

    else:
        highs = sorted([s.price for s in swings if s.kind == "SH"])
        sl_level = highs[0] if highs else entry * 1.002
        return sl_level + buffer


def calculate_take_profit(
    direction: SignalDirection,
    entry: float,
    stop_loss: float,
    rr_ratio: float = 2.0,
) -> float:
    risk = abs(entry - stop_loss)
    if direction == SignalDirection.LONG:
        return entry + risk * rr_ratio
    return entry - risk * rr_ratio


# ─────────────────────────────────────────────────────────────────────────────
#  Master Confluence Engine
# ─────────────────────────────────────────────────────────────────────────────

class SMCConfluenceEngine:
    """
    Orchestrates all three layers and emits a TradeSignal when
    confidence reaches 100% (all layers aligned).
    """

    def __init__(
        self,
        instrument: str,
        ema_period:   int   = 200,
        hysteresis:   float = 0.0001,
        swing_lb:     int   = 5,
        rr_ratio:     float = 2.0,
    ):
        self.instrument = instrument
        self.ema_period = ema_period
        self.hysteresis = hysteresis
        self.swing_lb   = swing_lb
        self.rr_ratio   = rr_ratio

    def analyze(
        self,
        candles: list[Candle],
        current_price: float,
        timestamp: int,
    ) -> Optional[TradeSignal]:
        """
        Run full 3-layer confluence check.
        Returns a TradeSignal only when all layers confirm (100% confidence).
        """
        state = ConfirmationState()

        # ── Layer 1 ──────────────────────────────────────────────────────────
        state.layer1_bias = layer1_trend_bias(candles, self.ema_period, self.hysteresis)
        if state.layer1_bias == Bias.NEUTRAL:
            return None  # No trade in ranging market

        # ── Layer 2 ──────────────────────────────────────────────────────────
        state.layer2_active, state.layer2_zone = layer2_value_zone(
            current_price, candles, state.layer1_bias
        )
        if not state.layer2_active:
            return None  # Price not in institutional zone

        # ── Layer 3 ──────────────────────────────────────────────────────────
        mss_confirmed, swing_level = layer3_market_structure_shift(
            candles, state.layer1_bias, self.swing_lb
        )
        state.layer3_mss = mss_confirmed
        if not state.layer3_mss:
            return None  # No structure break confirmation

        # ── All layers confirmed → build signal ──────────────────────────────
        direction = (
            SignalDirection.LONG
            if state.layer1_bias == Bias.BULLISH
            else SignalDirection.SHORT
        )
        state.direction = direction

        sl = calculate_dynamic_sl(direction, current_price, candles, self.swing_lb)
        tp = calculate_take_profit(direction, current_price, sl, self.rr_ratio)

        zone_label = (
            f"{'OB' if isinstance(state.layer2_zone, OrderBlock) else 'FVG'} "
            f"{state.layer2_zone.direction.value} "
            f"[{state.layer2_zone.ob_low if isinstance(state.layer2_zone, OrderBlock) else state.layer2_zone.gap_low:.5f}"
            f" – "
            f"{state.layer2_zone.ob_high if isinstance(state.layer2_zone, OrderBlock) else state.layer2_zone.gap_high:.5f}]"
        )

        return TradeSignal(
            instrument=self.instrument,
            direction=direction,
            entry_price=current_price,
            stop_loss=sl,
            take_profit=tp,
            confidence=100,
            layer1_bias=state.layer1_bias.value,
            layer2_zone=zone_label,
            layer3_mss=state.layer3_mss,
            timestamp=timestamp,
        )

    def get_partial_state(
        self,
        candles: list[Candle],
        current_price: float,
    ) -> ConfirmationState:
        """Return current confluence state even if not fully confirmed (for UI display)."""
        state = ConfirmationState()
        state.layer1_bias = layer1_trend_bias(candles, self.ema_period, self.hysteresis)
        if state.layer1_bias != Bias.NEUTRAL:
            state.layer2_active, state.layer2_zone = layer2_value_zone(
                current_price, candles, state.layer1_bias
            )
            if state.layer2_active:
                mss, _ = layer3_market_structure_shift(candles, state.layer1_bias, self.swing_lb)
                state.layer3_mss = mss
        return state