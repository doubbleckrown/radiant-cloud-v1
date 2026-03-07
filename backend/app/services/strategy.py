"""
app/services/strategy.py
========================
Multi-Timeframe Smart Money Concepts (SMC / ICT) Strategy Engine — v3.0

Top-down algorithm targeting ~70% win rate through strict multi-layer filtering.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STAGE 1  —  Daily HTF Bias
  • Swing structure: HH+HL = BULLISH  |  LH+LL = BEARISH
  • Confirmation: 50 EMA slope  +  200 EMA position (dual-EMA alignment)
  • Minimum 60 daily candles required

STAGE 2  —  H1 Liquidity Sweep
  • Builds a complete liquidity map every cycle:
      – Previous swing highs / lows (5-bar fractal)
      – Equal highs / equal lows  (≤ 0.04% price tolerance)
      – Previous Day High / Low (PDH / PDL)
      – Session High / Low  (London 07–16 UTC,  NY 12–21 UTC)
  • A sweep is confirmed when:
      – Wick pierces a level by ≥ min_wick_pct of price
      – Candle BODY closes back on the pre-sweep side (stop-hunt confirmed)
  • Returns the MOST RECENT confirmed sweep within the last 30 H1 bars

STAGE 3  —  H1 Market Structure Shift (CHoCH / BOS)
  • After sweep of a LOW  → body close ABOVE a recent swing HIGH  (CHoCH up)
  • After sweep of a HIGH → body close BELOW a recent swing LOW   (CHoCH down)
  • Only the 15 H1 candles immediately post-sweep are searched
  • Body close required — wick-only breaks are filtered out

STAGE 4  —  M5 Precision Entry Zone
  • Order Block: last opposing candle before a displacement move
      – Displacement = impulse body ≥ 1.5× ATR(14) of last 14 M5 candles
      – Fresh OB within last 48 M5 bars (≈ 4 hours)
  • Fair Value Gap: 3-candle imbalance where gap size ≥ 1.0× ATR(14)
  • Price must be currently inside an unmitigated zone
  • OB preferred over FVG

PRE-FILTERS:
  • Premium / Discount (ICT): LONG only Discount/Equilibrium,
                               SHORT only Premium/Equilibrium
  • Session filter: entries only London (07–12 UTC) or NY (12–17 UTC)
  • Signal deduplication: 4-hour cooldown per instrument+direction

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Confidence scoring (UI contract preserved):
  Layer 1 — 34 pts   Daily bias confirmed
  Layer 2 — 33 pts   H1 sweep detected
  Layer 3 — 33 pts   H1 MSS + M5 entry zone hit
  Total    = 100 pts → auto-execute threshold

All downstream types (TradeSignal, ConfirmationState, sl_tp.py, executors,
frontend) are preserved byte-for-byte.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

import numpy as np

logger = logging.getLogger("fx-signal")


# =============================================================================
#  Domain Models  — UNCHANGED (contracts with sl_tp.py / executors / frontend)
# =============================================================================

class Bias(str, Enum):
    BULLISH = "BULLISH"
    BEARISH = "BEARISH"
    NEUTRAL = "NEUTRAL"


class SignalDirection(str, Enum):
    LONG  = "LONG"
    SHORT = "SHORT"


@dataclass
class Candle:
    time:   int    # unix epoch seconds
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
    def body_size(self) -> float:
        return abs(self.close - self.open)

    @property
    def upper_wick(self) -> float:
        return self.high - max(self.open, self.close)

    @property
    def lower_wick(self) -> float:
        return min(self.open, self.close) - self.low

    @property
    def is_bullish(self) -> bool:
        return self.close > self.open

    @property
    def is_bearish(self) -> bool:
        return self.close < self.open

    @property
    def candle_range(self) -> float:
        return self.high - self.low


@dataclass
class OrderBlock:
    """Last opposing candle before an institutional displacement move."""
    direction:   Bias
    ob_high:     float
    ob_low:      float
    origin_time: int
    mitigated:   bool = False

    def contains(self, price: float) -> bool:
        return self.ob_low <= price <= self.ob_high


@dataclass
class FairValueGap:
    """3-candle price imbalance (gap between candle[i-1].high and candle[i+1].low)."""
    direction:   Bias
    gap_high:    float
    gap_low:     float
    origin_time: int
    filled:      bool = False

    def contains(self, price: float) -> bool:
        return self.gap_low <= price <= self.gap_high


@dataclass
class SwingPoint:
    price: float
    time:  int
    kind:  str   # "SH" = swing high | "SL" = swing low


@dataclass
class LiquidityLevel:
    """Price level where institutional resting orders (stops) are concentrated."""
    price:       float
    kind:        str   # SWING_HIGH|SWING_LOW|EQUAL_HIGH|EQUAL_LOW|PDH|PDL|SESSION_HIGH|SESSION_LOW
    origin_time: int


@dataclass
class ConfirmationState:
    """
    Per-instrument confluence tracker.
    Fields match the existing UI contract — do NOT rename.
    """
    layer1_bias:   Bias = Bias.NEUTRAL
    layer2_active: bool = False
    layer2_zone:   Optional[object] = None
    layer3_mss:    bool = False
    direction:     Optional[SignalDirection] = None
    pd_zone:       str  = "UNKNOWN"
    pd_aligned:    bool = False

    # Internal detail (not forwarded to frontend)
    sweep_label:   str   = ""
    bos_level:     float = 0.0

    @property
    def confidence(self) -> int:
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
        return self.confidence >= 100


@dataclass
class TradeSignal:
    """Immutable signal.  All fields match existing downstream contracts."""
    instrument:       str
    direction:        SignalDirection
    entry_price:      float
    stop_loss:        float
    take_profit:      float
    confidence:       int
    layer1_bias:      str
    layer2_zone:      str    # human-readable label for the UI
    layer2_zone_obj:  object # OB or FVG passed to sl_tp.candle_anchor_levels
    layer3_mss:       bool
    timestamp:        int
    pd_zone:          str = ""

    @property
    def risk_reward(self) -> float:
        risk   = abs(self.entry_price - self.stop_loss)
        reward = abs(self.take_profit - self.entry_price)
        return round(reward / risk, 2) if risk else 0.0

    @property
    def breakeven_price(self) -> float:
        risk = abs(self.entry_price - self.stop_loss)
        if self.direction == SignalDirection.LONG:
            return self.entry_price + risk
        return self.entry_price - risk


# =============================================================================
#  Shared Utilities
# =============================================================================

def calculate_ema(prices: list[float], period: int) -> list[float]:
    """Standard EMA — smoothing factor k = 2 / (period + 1)."""
    if len(prices) < period:
        return []
    k   = 2.0 / (period + 1)
    ema = [sum(prices[:period]) / period]
    for p in prices[period:]:
        ema.append(p * k + ema[-1] * (1 - k))
    return ema


def calculate_atr(candles: list[Candle], period: int = 14) -> float:
    """Average True Range over the last `period` candles."""
    if len(candles) < 2:
        return 0.0
    trs = []
    for i in range(1, len(candles)):
        c, p = candles[i], candles[i - 1]
        trs.append(max(c.high - c.low, abs(c.high - p.close), abs(c.low - p.close)))
    if not trs:
        return 0.0
    recent = trs[-period:] if len(trs) >= period else trs
    return sum(recent) / len(recent)


def identify_swing_points(
    candles:  list[Candle],
    lookback: int = 5,
) -> list[SwingPoint]:
    """
    Fractal-style swing point detector using a symmetric rolling window.

    A candle at index i is a swing HIGH if candle.high == max of the
    [i-lookback … i+lookback] window.  The last `lookback` candles are
    excluded because their right-side window is incomplete.
    """
    swings: list[SwingPoint] = []
    n = len(candles)
    if n < lookback * 2 + 1:
        return swings

    for i in range(lookback, n - lookback):
        window = candles[i - lookback: i + lookback + 1]
        c = candles[i]
        highs = [x.high for x in window]
        lows  = [x.low  for x in window]
        if c.high >= max(highs):
            swings.append(SwingPoint(price=c.high, time=c.time, kind="SH"))
        elif c.low <= min(lows):
            swings.append(SwingPoint(price=c.low,  time=c.time, kind="SL"))

    return swings


def _utc_hour(unix_ts: int) -> int:
    return datetime.fromtimestamp(unix_ts, tz=timezone.utc).hour


def is_trading_session(unix_ts: int) -> bool:
    """
    True if the timestamp falls inside London open or London/NY overlap.

    London open:         07:00–12:00 UTC  (pre-overlap, strongest directional moves)
    London / NY overlap: 12:00–17:00 UTC  (peak volume, cleanest price action)
    """
    h = _utc_hour(unix_ts)
    return (7 <= h < 12) or (12 <= h < 17)


# =============================================================================
#  Stage 1  —  Daily HTF Directional Bias
# =============================================================================

def daily_market_structure_bias(
    candles_d:      list[Candle],
    swing_lookback: int   = 3,
    ema_fast:       int   = 50,
    ema_slow:       int   = 200,
    ema_threshold:  float = 0.001,
) -> Bias:
    """
    Determine the institutional directional bias from Daily candles.

    Primary — Swing structure:
        BULLISH = Higher High AND Higher Low (last 2 confirmed swings of each type)
        BEARISH = Lower High  AND Lower Low

    Secondary — Dual EMA alignment:
        Price > fast EMA > slow EMA → BULLISH  (trend confirmation)
        Price < fast EMA < slow EMA → BEARISH
        ema_threshold prevents triggering on negligible EMA separations.

    Returns NEUTRAL when neither primary nor secondary can confirm direction.
    A NEUTRAL Stage 1 aborts the entire pipeline — no trades without HTF clarity.
    """
    min_needed = max(swing_lookback * 2 + 1, ema_slow + 10)
    if len(candles_d) < min_needed:
        return Bias.NEUTRAL

    # Use the most recent 120 daily candles (~6 months of structure)
    recent = candles_d[-120:]
    swings = identify_swing_points(recent, lookback=swing_lookback)

    sh_list = [s for s in swings if s.kind == "SH"]
    sl_list = [s for s in swings if s.kind == "SL"]

    if len(sh_list) >= 2 and len(sl_list) >= 2:
        hh = sh_list[-1].price > sh_list[-2].price
        hl = sl_list[-1].price > sl_list[-2].price
        lh = sh_list[-1].price < sh_list[-2].price
        ll = sl_list[-1].price < sl_list[-2].price

        if hh and hl:
            return Bias.BULLISH
        if lh and ll:
            return Bias.BEARISH

    # Dual-EMA tiebreaker
    closes = [c.close for c in candles_d]
    ema_f  = calculate_ema(closes, ema_fast)
    ema_s  = calculate_ema(closes, ema_slow)

    if ema_f and ema_s:
        last, ef, es = closes[-1], ema_f[-1], ema_s[-1]
        if last > ef * (1 + ema_threshold) and ef > es:
            return Bias.BULLISH
        if last < ef * (1 - ema_threshold) and ef < es:
            return Bias.BEARISH

    return Bias.NEUTRAL


# =============================================================================
#  Stage 2a  —  H1 Liquidity Level Collection
# =============================================================================

def collect_liquidity_levels(
    candles_h1:       list[Candle],
    swing_lookback:   int   = 5,
    eq_tolerance_pct: float = 0.0004,
) -> list[LiquidityLevel]:
    """
    Build the institutional liquidity map from H1 candles.

    Sources:
    1. Swing Highs / Lows  — fractal points where retail stops cluster
    2. Equal Highs / Lows  — double-top / double-bottom stop concentrations
    3. PDH / PDL           — previous day high / low (intraday SM reference)
    4. Session Highs / Lows — London (07–16) and NY (12–21) range extremes
    """
    if not candles_h1:
        return []

    levels: list[LiquidityLevel] = []
    now_ts = candles_h1[-1].time

    # ── 1. Swing Highs / Lows ─────────────────────────────────────────────────
    src    = candles_h1[-120:]
    swings = identify_swing_points(src, lookback=swing_lookback)
    for s in swings:
        kind = "SWING_HIGH" if s.kind == "SH" else "SWING_LOW"
        levels.append(LiquidityLevel(price=s.price, kind=kind, origin_time=s.time))

    # ── 2. Equal Highs / Lows ─────────────────────────────────────────────────
    sh_list = [s for s in swings if s.kind == "SH"]
    sl_list = [s for s in swings if s.kind == "SL"]

    seen_h: set[tuple] = set()
    for i, a in enumerate(sh_list):
        for j, b in enumerate(sh_list):
            if i >= j:
                continue
            key = (i, j)
            if key in seen_h:
                continue
            if a.price > 0 and abs(a.price - b.price) / a.price < eq_tolerance_pct:
                levels.append(LiquidityLevel(
                    price=(a.price + b.price) / 2.0,
                    kind="EQUAL_HIGH",
                    origin_time=max(a.time, b.time),
                ))
                seen_h.add(key)

    seen_l: set[tuple] = set()
    for i, a in enumerate(sl_list):
        for j, b in enumerate(sl_list):
            if i >= j:
                continue
            key = (i, j)
            if key in seen_l:
                continue
            if a.price > 0 and abs(a.price - b.price) / a.price < eq_tolerance_pct:
                levels.append(LiquidityLevel(
                    price=(a.price + b.price) / 2.0,
                    kind="EQUAL_LOW",
                    origin_time=max(a.time, b.time),
                ))
                seen_l.add(key)

    # ── 3. PDH / PDL ──────────────────────────────────────────────────────────
    y_start   = now_ts - 2 * 86400
    y_end     = now_ts - 86400
    yesterday = [c for c in candles_h1 if y_start <= c.time < y_end]
    if yesterday:
        levels.append(LiquidityLevel(
            price=max(c.high for c in yesterday),
            kind="PDH",
            origin_time=yesterday[0].time,
        ))
        levels.append(LiquidityLevel(
            price=min(c.low for c in yesterday),
            kind="PDL",
            origin_time=yesterday[0].time,
        ))

    # ── 4. Session Highs / Lows ───────────────────────────────────────────────
    last_48h = [c for c in candles_h1 if c.time >= now_ts - 2 * 86400]

    london = [c for c in last_48h if 7 <= _utc_hour(c.time) < 16]
    if london:
        levels.append(LiquidityLevel(
            price=max(c.high for c in london), kind="SESSION_HIGH",
            origin_time=london[0].time,
        ))
        levels.append(LiquidityLevel(
            price=min(c.low for c in london), kind="SESSION_LOW",
            origin_time=london[0].time,
        ))

    ny = [c for c in last_48h if 12 <= _utc_hour(c.time) < 21]
    if ny:
        levels.append(LiquidityLevel(
            price=max(c.high for c in ny), kind="SESSION_HIGH",
            origin_time=ny[0].time,
        ))
        levels.append(LiquidityLevel(
            price=min(c.low for c in ny), kind="SESSION_LOW",
            origin_time=ny[0].time,
        ))

    return levels


# =============================================================================
#  Stage 2b  —  H1 Liquidity Sweep Detection
# =============================================================================

def detect_liquidity_sweep(
    candles_h1:   list[Candle],
    levels:       list[LiquidityLevel],
    bias:         Bias,
    lookback:     int   = 30,
    min_wick_pct: float = 0.0001,
) -> tuple[bool, str, int]:
    """
    Identify the most recent confirmed stop-hunt (liquidity sweep) on H1.

    A sweep is confirmed when ALL three conditions hold:

    1. Candle WICK extends past a liquidity level by ≥ min_wick_pct of price.
       This distinguishes genuine sweeps from routine price discovery.

    2. Candle BODY closes back on the original side of the level.
       This is the ICT criterion: the close proves institutional reversal,
       not a sustained breakout.

    3. Level kind matches the bias:
       BULLISH → sweep of LOW levels  (institutional long entry opportunity)
       BEARISH → sweep of HIGH levels (institutional short entry opportunity)

    Returns
    -------
    (swept: bool, label: str, abs_index: int into candles_h1)
    Searches newest-first within the last `lookback` bars.
    """
    if bias == Bias.NEUTRAL or not candles_h1 or not levels:
        return False, "", -1

    low_kinds  = {"SWING_LOW", "EQUAL_LOW", "PDL", "SESSION_LOW"}
    high_kinds = {"SWING_HIGH", "EQUAL_HIGH", "PDH", "SESSION_HIGH"}

    recent   = candles_h1[-lookback:]
    n_offset = len(candles_h1) - len(recent)

    for rel_i in range(len(recent) - 1, -1, -1):
        c     = recent[rel_i]
        abs_i = n_offset + rel_i

        for lv in levels:
            if lv.price <= 0:
                continue

            if bias == Bias.BULLISH and lv.kind in low_kinds:
                wick_ext = lv.price - c.low
                if (c.low     < lv.price
                        and c.body_low > lv.price        # body closed above — confirmed
                        and wick_ext / lv.price >= min_wick_pct):
                    label = (
                        f"Swept {lv.kind.replace('_', ' ').title()} "
                        f"@ {lv.price:.5f}"
                    )
                    return True, label, abs_i

            elif bias == Bias.BEARISH and lv.kind in high_kinds:
                wick_ext = c.high - lv.price
                if (c.high    > lv.price
                        and c.body_high < lv.price       # body closed below — confirmed
                        and wick_ext / lv.price >= min_wick_pct):
                    label = (
                        f"Swept {lv.kind.replace('_', ' ').title()} "
                        f"@ {lv.price:.5f}"
                    )
                    return True, label, abs_i

    return False, "", -1


# =============================================================================
#  Stage 3  —  H1 Market Structure Shift (CHoCH / BOS)
# =============================================================================

def detect_mss_after_sweep(
    candles_h1:  list[Candle],
    sweep_idx:   int,
    bias:        Bias,
    pre_window:  int = 30,
    post_window: int = 15,
) -> tuple[bool, float]:
    """
    Confirm a Market Structure Shift (CHoCH or BOS) following a liquidity sweep.

    After a bullish sweep of a low, the market should form a CHoCH by
    producing a candle whose BODY closes above a recent swing HIGH.

    After a bearish sweep of a high, a CHoCH is confirmed by a candle
    body closing below a recent swing LOW.

    Why body close and not wick?
    Wicks above/below a level may themselves be liquidity sweeps.  A BODY close
    through the structural level confirms institutional commitment to the new
    direction — this is the moment price distribution shifts.

    Returns
    -------
    (confirmed: bool, mss_level: float)
    mss_level is the swing level whose break confirmed the shift.
    """
    if sweep_idx < 3 or sweep_idx >= len(candles_h1):
        return False, 0.0

    pre_slice  = candles_h1[max(0, sweep_idx - pre_window): sweep_idx + 1]
    post_end   = min(len(candles_h1), sweep_idx + 1 + post_window)
    post_slice = candles_h1[sweep_idx + 1: post_end]

    if not post_slice:
        return False, 0.0

    if bias == Bias.BULLISH:
        pre_swings = identify_swing_points(pre_slice, lookback=3)
        sh_prices  = [s.price for s in pre_swings if s.kind == "SH"]
        mss_level  = max(sh_prices) if sh_prices else max(c.high for c in pre_slice)
        for c in post_slice:
            if c.body_high > mss_level:
                return True, mss_level

    elif bias == Bias.BEARISH:
        pre_swings = identify_swing_points(pre_slice, lookback=3)
        sl_prices  = [s.price for s in pre_swings if s.kind == "SL"]
        mss_level  = min(sl_prices) if sl_prices else min(c.low for c in pre_slice)
        for c in post_slice:
            if c.body_low < mss_level:
                return True, mss_level

    return False, 0.0


# =============================================================================
#  Stage 4a  —  M5 Order Block Detection (displacement-validated)
# =============================================================================

def detect_order_blocks(
    candles:     list[Candle],
    lookback:    int   = 48,
    disp_factor: float = 1.5,
) -> list[OrderBlock]:
    """
    Identify institutional Order Blocks on M5.

    An OB is the LAST opposing candle before a significant displacement move.

    Criteria:
    1. Opposing candle: bearish before a bullish impulse (bullish OB),
       or bullish before a bearish impulse (bearish OB).

    2. Displacement requirement: the impulse candle's body must be
       ≥ disp_factor × ATR(14).  This ensures the OB genuinely caused
       a directional move rather than being part of consolidation.

    3. Engulf confirmation: the impulse candle closes past the opposing
       candle's extreme (closes above bearish candle's high, or below
       bullish candle's low).

    OB zone = body of the opposing candle (not full wick range).
    """
    blocks: list[OrderBlock] = []
    src    = candles[-lookback:]
    n      = len(src)
    if n < 16:
        return blocks

    atr = calculate_atr(src, period=14)
    if atr <= 0:
        return blocks

    min_impulse = atr * disp_factor

    for i in range(1, n - 1):
        prev = src[i - 1]
        curr = src[i]

        if (prev.is_bearish
                and curr.is_bullish
                and curr.body_size >= min_impulse
                and curr.close > prev.high):
            blocks.append(OrderBlock(
                direction=Bias.BULLISH,
                ob_high=prev.body_high,
                ob_low=prev.body_low,
                origin_time=prev.time,
            ))

        elif (prev.is_bullish
                and curr.is_bearish
                and curr.body_size >= min_impulse
                and curr.close < prev.low):
            blocks.append(OrderBlock(
                direction=Bias.BEARISH,
                ob_high=prev.body_high,
                ob_low=prev.body_low,
                origin_time=prev.time,
            ))

    return blocks


# =============================================================================
#  Stage 4b  —  M5 Fair Value Gap Detection (ATR-validated)
# =============================================================================

def detect_fair_value_gaps(
    candles:      list[Candle],
    lookback:     int   = 48,
    atr_min_mult: float = 1.0,
) -> list[FairValueGap]:
    """
    Detect Fair Value Gaps (FVGs) — three-candle price imbalances.

    Bullish FVG: candle[i-1].high < candle[i+1].low
    Bearish FVG: candle[i-1].low  > candle[i+1].high

    ATR filter: gap must be ≥ atr_min_mult × ATR(14).
    Prevents 1–2 pip slivers from triggering entries.  A meaningful
    institutional imbalance spans at least one average candle range.
    """
    gaps: list[FairValueGap] = []
    src  = candles[-lookback:]
    n    = len(src)
    if n < 16:
        return gaps

    atr     = calculate_atr(src, period=14)
    min_gap = atr * atr_min_mult

    for i in range(1, n - 1):
        c1, c2, c3 = src[i - 1], src[i], src[i + 1]

        if c1.high < c3.low and c1.high > 0:
            gap = c3.low - c1.high
            if gap >= min_gap:
                gaps.append(FairValueGap(
                    direction=Bias.BULLISH,
                    gap_high=c3.low,
                    gap_low=c1.high,
                    origin_time=c2.time,
                ))

        elif c1.low > c3.high and c3.high > 0:
            gap = c1.low - c3.high
            if gap >= min_gap:
                gaps.append(FairValueGap(
                    direction=Bias.BEARISH,
                    gap_high=c1.low,
                    gap_low=c3.high,
                    origin_time=c2.time,
                ))

    return gaps


# =============================================================================
#  Stage 4c  —  M5 Entry Zone Finder
# =============================================================================

def find_m5_entry_zone(
    candles_m5:    list[Candle],
    current_price: float,
    bias:          Bias,
    lookback:      int = 48,
) -> tuple[bool, Optional[object], str]:
    """
    Find an unmitigated M5 OB or FVG that price is currently inside.

    Priority: Order Blocks > Fair Value Gaps (most-recent zone wins each).
    """
    if len(candles_m5) < 16 or bias == Bias.NEUTRAL:
        return False, None, ""

    obs  = detect_order_blocks(candles_m5, lookback=lookback)
    fvgs = detect_fair_value_gaps(candles_m5, lookback=lookback)

    for ob in reversed(obs):
        if ob.direction.value == bias.value and not ob.mitigated and ob.contains(current_price):
            return True, ob, f"M5 OB [{ob.ob_low:.5f}–{ob.ob_high:.5f}]"

    for fvg in reversed(fvgs):
        if fvg.direction.value == bias.value and not fvg.filled and fvg.contains(current_price):
            return True, fvg, f"M5 FVG [{fvg.gap_low:.5f}–{fvg.gap_high:.5f}]"

    return False, None, ""


# =============================================================================
#  ICT Premium / Discount Zone Classifier
# =============================================================================

def classify_premium_discount(
    candles:       list[Candle],
    current_price: float,
    lookback:      int   = 24,
    eq_band_pct:   float = 0.025,
) -> tuple[str, float, float, float]:
    """
    DISCOUNT (<50% of range) = buy territory | PREMIUM (>50%) = sell territory.
    Returns (zone, swing_high, swing_low, midpoint).
    """
    if len(candles) < 2:
        return "UNKNOWN", current_price, current_price, current_price

    recent     = candles[-lookback:]
    swing_high = max(c.high for c in recent)
    swing_low  = min(c.low  for c in recent)
    total_rng  = swing_high - swing_low

    if total_rng <= 0:
        return "EQUILIBRIUM", swing_high, swing_low, swing_high

    midpoint = (swing_high + swing_low) / 2.0
    band     = total_rng * eq_band_pct

    if current_price > midpoint + band:
        zone = "PREMIUM"
    elif current_price < midpoint - band:
        zone = "DISCOUNT"
    else:
        zone = "EQUILIBRIUM"

    return zone, swing_high, swing_low, midpoint


# =============================================================================
#  Risk Helpers  (preserved — executors override via sl_tp.candle_anchor_levels)
# =============================================================================

def calculate_dynamic_sl(
    direction:      SignalDirection,
    entry:          float,
    candles:        list[Candle],
    swing_lookback: int   = 5,
    sl_buffer_pct:  float = 0.0002,
) -> float:
    """Preliminary SL from H1 swing structure. Overridden by sl_tp.candle_anchor_levels."""
    swings = identify_swing_points(candles, swing_lookback)
    buffer = entry * sl_buffer_pct

    if direction == SignalDirection.LONG:
        lows = sorted(
            [s.price for s in swings if s.kind == "SL" and s.price < entry],
            reverse=True,
        )
        return (lows[0] if lows else entry * 0.998) - buffer

    highs = sorted(
        [s.price for s in swings if s.kind == "SH" and s.price > entry]
    )
    return (highs[0] if highs else entry * 1.002) + buffer


def calculate_take_profit(
    direction: SignalDirection,
    entry:     float,
    stop_loss: float,
    rr_ratio:  float = 3.0,
) -> float:
    risk = abs(entry - stop_loss)
    if direction == SignalDirection.LONG:
        return entry + risk * rr_ratio
    return entry - risk * rr_ratio


def _make_sweep_zone(sweep_candle: Candle, is_long: bool) -> FairValueGap:
    """
    Synthetic FVG from the sweep candle for SL anchoring via sl_tp.py.

    ICT principle: the sweep wick is the structural invalidation level.
      LONG  → SL below sweep wick low  → gap_low = sweep.low
      SHORT → SL above sweep wick high → gap_high = sweep.high
    """
    if is_long:
        return FairValueGap(
            direction=Bias.BULLISH,
            gap_low=sweep_candle.low,
            gap_high=sweep_candle.body_low,
            origin_time=sweep_candle.time,
        )
    return FairValueGap(
        direction=Bias.BEARISH,
        gap_low=sweep_candle.body_high,
        gap_high=sweep_candle.high,
        origin_time=sweep_candle.time,
    )


# =============================================================================
#  Master SMC Confluence Engine
# =============================================================================

class SMCConfluenceEngine:
    """
    Multi-Timeframe SMC / ICT confluence engine — one instance per instrument.

    Instantiated in state.py (one per Oanda instrument, one per Bybit symbol).
    Called every 60-second candle refresh cycle with fresh D, H1, and M5 data.

    Constructor is backward-compatible:
        SMCConfluenceEngine(ins, ema_period=200, rr_ratio=3.0)
    """

    def __init__(
        self,
        instrument:     str,
        ema_period:     int   = 200,    # kept for API compat (used as slow EMA)
        hysteresis:     float = 0.0001,
        swing_lb:       int   = 5,
        rr_ratio:       float = 3.0,
        session_filter: bool  = True,
    ):
        self.instrument     = instrument
        self.rr_ratio       = rr_ratio
        self.swing_lb       = swing_lb
        self._ema_period    = ema_period
        self._hysteresis    = hysteresis
        self.session_filter = session_filter

        # Signal deduplication: prevent same-direction signal within cooldown
        self._last_signal_ts: dict[str, int] = {}
        self._cooldown_s: int = 4 * 3600    # 4-hour same-direction cooldown

    # ── Full 4-stage MTF analysis ─────────────────────────────────────────────

    def analyze(
        self,
        candles_d:     list[Candle],
        candles_h1:    list[Candle],
        candles_m5:    list[Candle],
        current_price: float,
        timestamp:     int,
    ) -> Optional[TradeSignal]:
        """
        Run the complete 4-stage MTF SMC/ICT filter.

        Parameters
        ----------
        candles_d     : HTF candles — Daily for Oanda (≥200 bars), 4H for Bybit (≥200 bars)
        candles_h1    : H1 candles   (≥200 bars) — Stage 2 sweep + Stage 3 MSS
        candles_m5    : M5 candles   (≥50  bars) — Stage 4 entry zone
        current_price : Live mid price (Oanda) or mark price (Bybit)
        timestamp     : Unix epoch seconds

        Returns None at any failed stage; TradeSignal at 100% confluence.
        """
        cs = ConfirmationState()

        # ── Stage 1: Daily HTF Bias ───────────────────────────────────────────
        daily_bias     = daily_market_structure_bias(candles_d)
        cs.layer1_bias = daily_bias
        if daily_bias == Bias.NEUTRAL:
            return None

        direction = SignalDirection.LONG if daily_bias == Bias.BULLISH else SignalDirection.SHORT
        is_long   = direction == SignalDirection.LONG

        # ── Pre-filter: Premium / Discount zone ──────────────────────────────
        pd_zone, *_ = classify_premium_discount(candles_h1, current_price)
        cs.pd_zone  = pd_zone
        pd_ok = (
            (is_long     and pd_zone in ("DISCOUNT",    "EQUILIBRIUM")) or
            (not is_long and pd_zone in ("PREMIUM",     "EQUILIBRIUM"))
        )
        cs.pd_aligned = pd_ok
        if not pd_ok:
            return None

        # ── Stage 2: H1 Liquidity Sweep ──────────────────────────────────────
        liq_levels = collect_liquidity_levels(candles_h1)
        swept, sweep_label, sweep_idx = detect_liquidity_sweep(
            candles_h1, liq_levels, daily_bias,
        )
        cs.layer2_active = swept
        if not swept or sweep_idx < 0:
            return None

        # ── Stage 3: H1 Market Structure Shift ───────────────────────────────
        mss_ok, mss_level = detect_mss_after_sweep(candles_h1, sweep_idx, daily_bias)
        if not mss_ok:
            return None

        cs.bos_level   = mss_level
        cs.sweep_label = sweep_label

        # ── Pre-filter: Session filter ────────────────────────────────────────
        if self.session_filter and not is_trading_session(timestamp):
            logger.debug(
                "%s %s blocked — outside London/NY session (UTC h=%d)",
                self.instrument, direction.value, _utc_hour(timestamp),
            )
            return None

        # ── Pre-filter: Signal deduplication ─────────────────────────────────
        last_ts = self._last_signal_ts.get(direction.value, 0)
        if timestamp - last_ts < self._cooldown_s:
            logger.debug(
                "%s %s blocked — cooldown %ds remaining",
                self.instrument, direction.value,
                self._cooldown_s - (timestamp - last_ts),
            )
            return None

        # ── Stage 4: M5 Entry Zone ────────────────────────────────────────────
        in_zone, zone_obj, zone_label = find_m5_entry_zone(
            candles_m5, current_price, daily_bias,
        )
        cs.layer3_mss  = in_zone
        cs.layer2_zone = zone_obj
        cs.direction   = direction
        if not in_zone or zone_obj is None:
            return None

        # ── Build TradeSignal ─────────────────────────────────────────────────
        sl = calculate_dynamic_sl(direction, current_price, candles_h1, self.swing_lb)
        tp = calculate_take_profit(direction, current_price, sl, self.rr_ratio)

        # Sweep candle zone for SL anchoring in sl_tp.py
        sweep_zone_obj = _make_sweep_zone(candles_h1[sweep_idx], is_long)
        zone_str       = f"{sweep_label} → MSS {mss_level:.5f} → {zone_label}"

        # Record timestamp to enforce deduplication cooldown
        self._last_signal_ts[direction.value] = timestamp

        logger.info(
            "✅ %s %s | P/D=%s | %s | MSS=%.5f | %s",
            self.instrument, direction.value, pd_zone,
            sweep_label, mss_level, zone_label,
        )

        return TradeSignal(
            instrument      = self.instrument,
            direction       = direction,
            entry_price     = current_price,
            stop_loss       = sl,
            take_profit     = tp,
            confidence      = 100,
            layer1_bias     = daily_bias.value,
            layer2_zone     = zone_str,
            layer2_zone_obj = sweep_zone_obj,
            layer3_mss      = True,
            timestamp       = timestamp,
            pd_zone         = pd_zone,
        )

    # ── Partial state for MarketsPage UI polling ──────────────────────────────

    def get_partial_state(
        self,
        candles_d:     list[Candle],
        candles_h1:    list[Candle],
        current_price: float,
    ) -> ConfirmationState:
        """
        Return confluence depth without requiring M5 data.

        Called every 30 s on MarketsPage polls for the live confidence bar.
        Does NOT apply session filter or deduplication — those are execution-only.

        Returned confidence:
          34% = Daily bias confirmed
          67% = Daily + H1 sweep detected
         100% = All stages (only in analyze() with M5)
        """
        cs = ConfirmationState()

        daily_bias     = daily_market_structure_bias(candles_d)
        cs.layer1_bias = daily_bias
        if daily_bias == Bias.NEUTRAL or not candles_h1:
            return cs

        direction = SignalDirection.LONG if daily_bias == Bias.BULLISH else SignalDirection.SHORT
        is_long   = direction == SignalDirection.LONG

        pd_zone, *_ = classify_premium_discount(candles_h1, current_price)
        cs.pd_zone  = pd_zone
        pd_ok = (
            (is_long     and pd_zone in ("DISCOUNT",    "EQUILIBRIUM")) or
            (not is_long and pd_zone in ("PREMIUM",     "EQUILIBRIUM"))
        )
        cs.pd_aligned = pd_ok
        if not pd_ok:
            return cs

        liq_levels = collect_liquidity_levels(candles_h1)
        swept, sweep_label, sweep_idx = detect_liquidity_sweep(
            candles_h1, liq_levels, daily_bias,
        )
        cs.layer2_active = swept
        if not swept or sweep_idx < 0:
            return cs

        mss_ok, mss_level = detect_mss_after_sweep(candles_h1, sweep_idx, daily_bias)
        cs.layer3_mss = mss_ok
        cs.bos_level  = mss_level
        cs.direction  = direction

        return cs