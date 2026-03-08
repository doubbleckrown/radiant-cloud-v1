"""
app/services/crypto_strategy.py
================================
Crypto-Optimised SMC Engine for Bybit perpetual markets.

WHY a separate engine?
───────────────────────
The classic SMC/ICT model (strategy.py) is calibrated for Forex session-based
markets where:
  • Price respects strict 50% Premium/Discount equilibrium before reversing
  • Deep retracements (≥50% of prior range) are the norm
  • Market sessions (London/NY) define high-probability windows

Crypto markets have fundamentally different microstructure:
  • 24/7 continuous trading — no session clock
  • Heavy retail participation → predictable stop clusters at equal highs/lows
  • Whale manipulation and leverage liquidation cascades
  • Funding rate pressure creates directional trends with SHALLOW pullbacks
  • FVGs fill quickly and precisely before continuation
  • Price respects 4H structure rather than Daily structure

STRATEGY PIPELINE  (4 stages, same confidence scoring contract as Forex)
──────────────────────────────────────────────────────────────────────────

  Stage 1 — 4H Directional Bias                                [+34 pts]
    • Swing structure: HH+HL = BULLISH | LH+LL = BEARISH
    • Dual EMA (50/200) on 4H as tiebreaker when structure is ambiguous
    • No session filter — crypto never sleeps

  Stage 2 — 15m Liquidity Sweep                                [+33 pts]
    • Builds a liquidity map from 15m candles:
        – Equal highs / equal lows  (primary crypto stop-hunt targets, 0.08% tol.)
        – Swing highs / lows        (fractal, lookback=3 — sensitive on 15m)
        – Previous 4H high / low    (institutional reference candle)
    • Sweep: wick pierces level + BODY closes back (same ICT criterion as Forex)
    • Equal levels searched first — they are more reliably swept in crypto
    • Wider lookback window (50 bars ≈ 12.5h of 15m data)

  Stage 3 — 15m Momentum Confirmation                          [+33 pts]
    • Does NOT require a full CHoCH — crypto moves too fast for that
    • Criterion A: Momentum candle  body ≥ 1.5× ATR(14) in bias direction
    • Criterion B: Structure break  body close above pre-sweep SH (bullish)
                                                 below pre-sweep SL (bearish)
    • Either criterion is sufficient
    • Post-sweep search window: 10 candles (tighter than Forex 15-bar window)

  Stage 4 — 5m Imbalance / Entry Zone                         [auto — full conf]
    • FVG prioritised over OB (crypto FVGs fill with high precision)
    • Order Block as fallback when no FVG is present
    • Price must be currently inside the unmitigated zone

  Pre-filter — Trend Position Filter  (replaces strict 50% P/D zone)
    • Uses last 50 4H candles for range reference
    • LONG  blocked only if price is in TOP 20% of 4H range (extended premium)
    • SHORT blocked only if price is in BOTTOM 20% of 4H range (extended discount)
    • Middle 60% classified as EQUILIBRIUM → both directions allowed
    • Returns DISCOUNT / PREMIUM / EQUILIBRIUM for full frontend compatibility

  Signal Deduplication: 2-hour cooldown (vs 4h Forex) — crypto rotates faster

TIMEFRAME MAPPING (positional args match SMCConfluenceEngine exactly):
    candles_d   slot → 4H  candles   (bias)
    candles_h1  slot → 15m candles  (structure + sweep)
    candles_m5  slot → 5m  candles  (entry zone)

This means engine.py and routes_markets.py only need to pass candles_15m
in the second positional slot — the engine interface is unchanged.
"""
from __future__ import annotations

import logging
from typing import Optional

from app.services.strategy import (
    # ── Data models (preserved — UI + executor contracts depend on these) ──────
    Bias, SignalDirection, Candle,
    OrderBlock, FairValueGap, LiquidityLevel,
    ConfirmationState, TradeSignal,
    # ── Utilities reused as-is ────────────────────────────────────────────────
    calculate_atr,
    identify_swing_points,
    # ── Stage functions reused as-is ──────────────────────────────────────────
    daily_market_structure_bias,   # works fine on 4H candles
    detect_order_blocks,           # Stage 4 — same M5 detection
    detect_fair_value_gaps,        # Stage 4 — same M5 detection
    calculate_dynamic_sl,
    calculate_take_profit,
    _make_sweep_zone,
)

logger = logging.getLogger("fx-signal")


# =============================================================================
#  Stage 2a  —  Crypto Liquidity Level Collection (15m)
# =============================================================================

def collect_crypto_liquidity_levels(
    candles_15m:      list[Candle],
    candles_4h:       list[Candle],
    swing_lookback:   int   = 3,
    eq_tolerance_pct: float = 0.0008,   # 0.08% — 2× Forex tolerance (crypto volatility)
) -> list[LiquidityLevel]:
    """
    Build a crypto-specific liquidity map from 15m candles.

    Priority order (reflects how crypto price typically sweeps levels):
      1. Equal highs / equal lows  — double-top/bottom stop clusters, most
                                     reliably swept by whales before reversals.
      2. Swing highs / lows        — fractal levels on 15m (lookback=3).
      3. Previous 4H high / low    — institutional bracket reference.

    Uses last 200 × 15m candles (≈50 hours) for level detection.
    """
    if not candles_15m:
        return []

    levels: list[LiquidityLevel] = []
    src    = candles_15m[-200:]
    swings = identify_swing_points(src, lookback=swing_lookback)

    sh_list = [s for s in swings if s.kind == "SH"]
    sl_list = [s for s in swings if s.kind == "SL"]

    # ── 1. Equal Highs (primary stop clusters) ───────────────────────────────
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
                    price       = (a.price + b.price) / 2.0,
                    kind        = "EQUAL_HIGH",
                    origin_time = max(a.time, b.time),
                ))
                seen_h.add(key)

    # ── 1. Equal Lows ─────────────────────────────────────────────────────────
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
                    price       = (a.price + b.price) / 2.0,
                    kind        = "EQUAL_LOW",
                    origin_time = max(a.time, b.time),
                ))
                seen_l.add(key)

    # ── 2. Swing Highs / Lows ─────────────────────────────────────────────────
    for s in swings:
        kind = "SWING_HIGH" if s.kind == "SH" else "SWING_LOW"
        levels.append(LiquidityLevel(price=s.price, kind=kind, origin_time=s.time))

    # ── 3. Previous 4H High / Low ─────────────────────────────────────────────
    if len(candles_4h) >= 2:
        prev_4h = candles_4h[-2]   # last fully closed 4H candle
        levels.append(LiquidityLevel(
            price=prev_4h.high, kind="PDH", origin_time=prev_4h.time,
        ))
        levels.append(LiquidityLevel(
            price=prev_4h.low, kind="PDL", origin_time=prev_4h.time,
        ))

    return levels


# =============================================================================
#  Stage 2b  —  Crypto Liquidity Sweep Detection (15m)
# =============================================================================

def detect_crypto_sweep(
    candles_15m:  list[Candle],
    levels:       list[LiquidityLevel],
    bias:         Bias,
    lookback:     int   = 50,    # 50 × 15m ≈ 12.5h; wider than Forex 30 × H1
    min_wick_pct: float = 0.0001,
) -> tuple[bool, str, int]:
    """
    Identify the most recent confirmed liquidity sweep on 15m.

    Same ICT criterion as Forex (wick pierces + body closes back) but:
      • Wider lookback (50 bars — crypto sweeps can build over several hours)
      • Equal highs/lows searched FIRST — they are the primary crypto target
      • Shorter human label (4dp price) suited for crypto's higher prices

    Returns (swept: bool, label: str, abs_index: int into candles_15m).
    """
    if bias == Bias.NEUTRAL or not candles_15m or not levels:
        return False, "", -1

    low_kinds  = {"SWING_LOW", "EQUAL_LOW", "PDL"}
    high_kinds = {"SWING_HIGH", "EQUAL_HIGH", "PDH"}

    # Sort so equal levels are evaluated first within each candle iteration
    def _priority(lv: LiquidityLevel) -> int:
        return 0 if lv.kind in ("EQUAL_HIGH", "EQUAL_LOW") else (
               1 if lv.kind in ("SWING_HIGH", "SWING_LOW") else 2)

    sorted_levels = sorted(levels, key=_priority)

    recent   = candles_15m[-lookback:]
    n_offset = len(candles_15m) - len(recent)

    for rel_i in range(len(recent) - 1, -1, -1):
        c     = recent[rel_i]
        abs_i = n_offset + rel_i

        for lv in sorted_levels:
            if lv.price <= 0:
                continue

            if bias == Bias.BULLISH and lv.kind in low_kinds:
                wick_ext = lv.price - c.low
                if (c.low      < lv.price
                        and c.body_low  > lv.price          # body closed above → confirmed
                        and wick_ext / lv.price >= min_wick_pct):
                    kind_tag = (
                        "EQL"  if lv.kind == "EQUAL_LOW"  else
                        lv.kind.replace("_", " ").title()
                    )
                    return True, f"Swept {kind_tag} @ {lv.price:.4f}", abs_i

            elif bias == Bias.BEARISH and lv.kind in high_kinds:
                wick_ext = c.high - lv.price
                if (c.high     > lv.price
                        and c.body_high < lv.price          # body closed below → confirmed
                        and wick_ext / lv.price >= min_wick_pct):
                    kind_tag = (
                        "EQH"  if lv.kind == "EQUAL_HIGH" else
                        lv.kind.replace("_", " ").title()
                    )
                    return True, f"Swept {kind_tag} @ {lv.price:.4f}", abs_i

    return False, "", -1


# =============================================================================
#  Stage 3  —  Crypto Momentum Confirmation (15m)
# =============================================================================

def detect_crypto_momentum(
    candles_15m: list[Candle],
    sweep_idx:   int,
    bias:        Bias,
    pre_window:  int = 20,
    post_window: int = 10,   # 10 × 15m = 2.5h — tighter than Forex 15 × H1
) -> tuple[bool, float]:
    """
    Confirm momentum continuation following a crypto liquidity sweep.

    Crypto does not require a full CHoCH (Change of Character) — the
    explosive nature of liquidation cascades means momentum is confirmed
    either by:

    Criterion A — Momentum Candle
        A candle whose body ≥ 1.5× ATR(14) fires in the bias direction
        within `post_window` bars of the sweep.  This captures the initial
        cascade flush that precedes the trend continuation.

    Criterion B — Structure Break
        Price body closes ABOVE the most recent pre-sweep swing high (BULLISH)
        or BELOW the most recent pre-sweep swing low (BEARISH).  Equivalent
        to Forex BOS but at the faster 15m timeframe.

    Either criterion triggers stage 3 — the first one found wins.

    Returns (confirmed: bool, key_level: float)
        key_level is used for context in the signal label.
    """
    if sweep_idx < 3 or sweep_idx >= len(candles_15m):
        return False, 0.0

    pre_slice  = candles_15m[max(0, sweep_idx - pre_window): sweep_idx + 1]
    post_end   = min(len(candles_15m), sweep_idx + 1 + post_window)
    post_slice = candles_15m[sweep_idx + 1: post_end]

    if not post_slice or not pre_slice:
        return False, 0.0

    # ATR computed over pre + post context window
    atr = calculate_atr(pre_slice + post_slice, period=14)
    if atr <= 0:
        return False, 0.0

    min_momentum_body = atr * 1.5

    if bias == Bias.BULLISH:
        pre_swings = identify_swing_points(pre_slice, lookback=3)
        sh_prices  = [s.price for s in pre_swings if s.kind == "SH"]
        key_level  = max(sh_prices) if sh_prices else max(c.high for c in pre_slice)

        for c in post_slice:
            # A: large bullish body → liquidation cascade buying
            if c.is_bullish and c.body_size >= min_momentum_body:
                return True, key_level
            # B: body close above pre-sweep swing high → structure break
            if c.body_high > key_level:
                return True, key_level

    elif bias == Bias.BEARISH:
        pre_swings = identify_swing_points(pre_slice, lookback=3)
        sl_prices  = [s.price for s in pre_swings if s.kind == "SL"]
        key_level  = min(sl_prices) if sl_prices else min(c.low for c in pre_slice)

        for c in post_slice:
            # A: large bearish body → liquidation cascade selling
            if c.is_bearish and c.body_size >= min_momentum_body:
                return True, key_level
            # B: body close below pre-sweep swing low → structure break
            if c.body_low < key_level:
                return True, key_level

    return False, 0.0


# =============================================================================
#  Trend Position Filter  (replaces strict 50% Premium/Discount zone)
# =============================================================================

def crypto_trend_position_filter(
    candles_4h:     list[Candle],
    current_price:  float,
    lookback:       int   = 50,          # ~8 days of 4H candles
    extreme_buffer: float = 0.20,        # block entries in top/bottom 20% of range
) -> tuple[str, float, float, float]:
    """
    Trend-position filter for crypto — replaces the Forex 50% P/D zone.

    Crypto trends with shallow pullbacks, so the strict 50%-midpoint filter
    in classify_premium_discount() would reject the majority of valid crypto
    entries.  Instead this filter only blocks:

      LONG  → when price is in the TOP 20% of the 4H range (chasing extended move)
      SHORT → when price is in the BOTTOM 20% of the 4H range (shorting oversold)

    The remaining 60% of the range is labelled EQUILIBRIUM (both directions OK).

    Uses most-recent confirmed swing points from the last `lookback` 4H candles
    for the range reference (same methodology as classify_premium_discount).

    Returns (zone, range_high, range_low, midpoint) — identical tuple shape
    to classify_premium_discount() so ConfirmationState and TradeSignal are
    fully compatible with existing frontend rendering.
    """
    if len(candles_4h) < 3:
        return "UNKNOWN", current_price, current_price, current_price

    src    = candles_4h[-lookback:]
    swings = identify_swing_points(src, lookback=3)

    sh_list = [s for s in swings if s.kind == "SH"]
    sl_list = [s for s in swings if s.kind == "SL"]

    if sh_list and sl_list:
        range_high = sh_list[-1].price
        range_low  = sl_list[-1].price
        # Ensure directional ordering (most recent SH could be older than most recent SL)
        if range_high <= range_low:
            range_high = max(s.price for s in sh_list)
            range_low  = min(s.price for s in sl_list)
    else:
        # Fallback: absolute range of last 20 4H candles
        src20      = candles_4h[-20:]
        range_high = max(c.high for c in src20)
        range_low  = min(c.low  for c in src20)

    total_range = range_high - range_low
    if total_range <= 0:
        midpoint = (range_high + range_low) / 2.0
        return "EQUILIBRIUM", range_high, range_low, midpoint

    midpoint = (range_high + range_low) / 2.0
    position = (current_price - range_low) / total_range   # 0.0 = bottom, 1.0 = top

    if position >= (1.0 - extreme_buffer):          # top 20%
        zone = "PREMIUM"
    elif position <= extreme_buffer:                 # bottom 20%
        zone = "DISCOUNT"
    else:                                            # middle 60%
        zone = "EQUILIBRIUM"

    return zone, range_high, range_low, midpoint


# =============================================================================
#  Stage 4  —  5m Imbalance / Entry Zone
# =============================================================================

def find_crypto_entry_zone(
    candles_5m:    list[Candle],
    current_price: float,
    bias:          Bias,
    lookback:      int = 48,
) -> tuple[bool, Optional[object], str]:
    """
    Find an unmitigated 5m FVG or OB for crypto entry.

    FVG is prioritised over OB for crypto because:
      • Crypto FVGs are caused by high-velocity liquidation moves
      • Price returns to fill the imbalance before continuation with high precision
      • OBs are valid but less precise at the 5m level in volatile markets

    Uses the same detect_order_blocks() and detect_fair_value_gaps() functions
    as the Forex engine — the detection logic is timeframe-agnostic.
    """
    if len(candles_5m) < 16 or bias == Bias.NEUTRAL:
        return False, None, ""

    fvgs = detect_fair_value_gaps(candles_5m, lookback=lookback)
    obs  = detect_order_blocks(candles_5m,    lookback=lookback)

    # FVG first (higher precision for crypto entries)
    for fvg in reversed(fvgs):
        if (fvg.direction.value == bias.value
                and not fvg.filled
                and fvg.contains(current_price)):
            return True, fvg, f"5m FVG [{fvg.gap_low:.4f}–{fvg.gap_high:.4f}]"

    # OB fallback
    for ob in reversed(obs):
        if (ob.direction.value == bias.value
                and not ob.mitigated
                and ob.contains(current_price)):
            return True, ob, f"5m OB [{ob.ob_low:.4f}–{ob.ob_high:.4f}]"

    return False, None, ""


# =============================================================================
#  Crypto SMC Confluence Engine
# =============================================================================

class CryptoSMCEngine:
    """
    Crypto-optimised SMC engine — one instance per Bybit symbol.

    Identical interface to SMCConfluenceEngine (strategy.py) so it is a
    transparent drop-in replacement in state.py and bybit/engine.py.

    Positional argument mapping (unchanged from caller's perspective):
        candles_d   ← 4H candles  (bias stage)
        candles_h1  ← 15m candles (structure + sweep + momentum)
        candles_m5  ← 5m candles  (entry zone)

    Confidence scoring contract preserved:
        34%  Stage 1 — 4H bias confirmed
        67%  Stage 1 + Stage 2 — sweep detected
        100% All stages — entry zone hit → auto-execute
    """

    def __init__(
        self,
        instrument:     str,
        ema_period:     int   = 200,    # kept for API compat — used as slow EMA in bias
        hysteresis:     float = 0.0001, # kept for API compat — unused in crypto logic
        swing_lb:       int   = 5,
        rr_ratio:       float = 3.0,
        session_filter: bool  = False,  # crypto is 24/7 — always False
    ):
        self.instrument  = instrument
        self.rr_ratio    = rr_ratio
        self.swing_lb    = swing_lb
        self._ema_period = ema_period

        # 2-hour cooldown — faster than Forex 4h because crypto rotates quicker
        self._last_signal_ts: dict[str, int] = {}
        self._cooldown_s: int = 2 * 3600

    # ── Full 4-stage MTF analysis ─────────────────────────────────────────────

    def analyze(
        self,
        candles_d:     list[Candle],   # ← 4H for Bybit
        candles_h1:    list[Candle],   # ← 15m for Bybit
        candles_m5:    list[Candle],   # ← 5m for Bybit
        current_price: float,
        timestamp:     int,
    ) -> Optional[TradeSignal]:
        """
        Run the complete crypto 4-stage MTF filter.

        candles_d  : 4H  candles — ≥200 bars required for EMA-200 bias
        candles_h1 : 15m candles — ≥100 bars for sweep + momentum detection
        candles_m5 : 5m  candles — ≥20  bars for entry zone detection
        """
        cs = ConfirmationState()

        # ── Stage 1: 4H HTF Bias ──────────────────────────────────────────────
        # Reuses the Forex daily_market_structure_bias() — the swing HH/HL
        # and dual-EMA logic is timeframe-agnostic.
        bias           = daily_market_structure_bias(candles_d)
        cs.layer1_bias = bias
        if bias == Bias.NEUTRAL:
            return None

        direction = SignalDirection.LONG if bias == Bias.BULLISH else SignalDirection.SHORT
        is_long   = direction == SignalDirection.LONG

        # ── Pre-filter: Trend Position (crypto P/D replacement) ──────────────
        # Only blocks entries at the extreme 20% edges of the 4H range.
        # Middle 60% is EQUILIBRIUM — both directions allowed.
        pd_zone, *_ = crypto_trend_position_filter(candles_d, current_price)
        cs.pd_zone   = pd_zone
        pd_ok = (
            (is_long     and pd_zone in ("DISCOUNT",    "EQUILIBRIUM")) or
            (not is_long and pd_zone in ("PREMIUM",     "EQUILIBRIUM"))
        )
        cs.pd_aligned = pd_ok
        if not pd_ok:
            return None

        # ── Stage 2: 15m Liquidity Sweep ──────────────────────────────────────
        liq_levels = collect_crypto_liquidity_levels(candles_h1, candles_d)
        swept, sweep_label, sweep_idx = detect_crypto_sweep(
            candles_h1, liq_levels, bias,
        )
        cs.layer2_active = swept
        if not swept or sweep_idx < 0:
            return None

        # ── Stage 3: 15m Momentum Confirmation ────────────────────────────────
        momentum_ok, momentum_level = detect_crypto_momentum(
            candles_h1, sweep_idx, bias,
        )
        if not momentum_ok:
            return None

        cs.bos_level   = momentum_level
        cs.sweep_label = sweep_label

        # ── Pre-filter: Signal Deduplication ─────────────────────────────────
        last_ts = self._last_signal_ts.get(direction.value, 0)
        if timestamp - last_ts < self._cooldown_s:
            logger.debug(
                "%s %s blocked — cooldown %ds remaining",
                self.instrument, direction.value,
                self._cooldown_s - (timestamp - last_ts),
            )
            return None

        # ── Stage 4: 5m Entry Zone (FVG / OB) ─────────────────────────────────
        in_zone, zone_obj, zone_label = find_crypto_entry_zone(
            candles_m5, current_price, bias,
        )
        cs.layer3_mss  = in_zone
        cs.layer2_zone = zone_obj
        cs.direction   = direction
        if not in_zone or zone_obj is None:
            return None

        # ── Build TradeSignal ─────────────────────────────────────────────────
        sl = calculate_dynamic_sl(direction, current_price, candles_h1, self.swing_lb)
        tp = calculate_take_profit(direction, current_price, sl, self.rr_ratio)

        # Use sweep candle wick as SL anchor (same as Forex)
        sweep_zone_obj = _make_sweep_zone(candles_h1[sweep_idx], is_long)
        zone_str       = f"{sweep_label} → MOM {momentum_level:.4f} → {zone_label}"

        self._last_signal_ts[direction.value] = timestamp

        logger.info(
            "✅ CRYPTO %s %s | Zone=%s | %s | MOM=%.4f | %s",
            self.instrument, direction.value, pd_zone,
            sweep_label, momentum_level, zone_label,
        )

        return TradeSignal(
            instrument      = self.instrument,
            direction       = direction,
            entry_price     = current_price,
            stop_loss       = sl,
            take_profit     = tp,
            confidence      = 100,
            layer1_bias     = bias.value,
            layer2_zone     = zone_str,
            layer2_zone_obj = sweep_zone_obj,
            layer3_mss      = True,
            timestamp       = timestamp,
            pd_zone         = pd_zone,
        )

    # ── Partial state for MarketsPage UI polling ──────────────────────────────

    def get_partial_state(
        self,
        candles_d:     list[Candle],   # ← 4H
        candles_h1:    list[Candle],   # ← 15m
        current_price: float,
    ) -> ConfirmationState:
        """
        Return confluence depth without requiring 5m data.

        Called every 30s by the MarketsPage poll.  No deduplication applied —
        the UI confidence bar should reflect live structure, not cooldown state.

        Confidence returned:
          34% = 4H bias confirmed
          67% = 4H bias + 15m sweep detected
         100% = All stages (only analyze() can produce this — needs 5m data)
        """
        cs = ConfirmationState()

        bias           = daily_market_structure_bias(candles_d)
        cs.layer1_bias = bias
        if bias == Bias.NEUTRAL or not candles_h1:
            return cs

        direction = SignalDirection.LONG if bias == Bias.BULLISH else SignalDirection.SHORT
        is_long   = direction == SignalDirection.LONG

        pd_zone, *_ = crypto_trend_position_filter(candles_d, current_price)
        cs.pd_zone   = pd_zone
        pd_ok = (
            (is_long     and pd_zone in ("DISCOUNT",    "EQUILIBRIUM")) or
            (not is_long and pd_zone in ("PREMIUM",     "EQUILIBRIUM"))
        )
        cs.pd_aligned = pd_ok
        if not pd_ok:
            return cs

        liq_levels = collect_crypto_liquidity_levels(candles_h1, candles_d)
        swept, sweep_label, sweep_idx = detect_crypto_sweep(
            candles_h1, liq_levels, bias,
        )
        cs.layer2_active = swept
        if not swept or sweep_idx < 0:
            return cs

        momentum_ok, momentum_level = detect_crypto_momentum(
            candles_h1, sweep_idx, bias,
        )
        cs.layer3_mss  = momentum_ok
        cs.bos_level   = momentum_level if momentum_ok else 0.0
        cs.direction   = direction

        return cs