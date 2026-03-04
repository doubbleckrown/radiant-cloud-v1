"""
app/engines/sl_tp.py
====================
SMC Candle-Anchor SL/TP Calculator — shared by Oanda and Bybit executors.

Method
------
Instead of using the SMC engine's theoretical entry_price/stop_loss/take_profit
(which are computed from candle patterns at analysis time and may be stale by
execution time), we recalculate fresh levels from the *current* mark price and
the previous H1 candle's Low/High:

  Buy  (LONG):
    SL  = prev_candle.low  - buffer        (anchor below the last candle)
    TP  = mark_price + 3 × (mark_price - SL)   (1:3 R:R)

  Sell (SHORT):
    SL  = prev_candle.high + buffer        (anchor above the last candle)
    TP  = mark_price - 3 × (SL - mark_price)   (1:3 R:R)

Buffer and max-SL-distance are instrument-class-aware so we never over-leverage
on tight FX pairs or blow past a safety gate on slow-moving indices.

Returns
-------
(sl, tp, sl_dist) as floats, already validated for geometry.

Raises
------
ValueError  with a descriptive reason on any safety violation so the caller
            can stamp exec_status='skipped' without hitting the exchange API.
"""
from __future__ import annotations
from dataclasses import dataclass

from app.services.strategy import Candle


# ─────────────────────────────────────────────────────────────────────────────
#  Instrument-class configuration
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class _InstrClass:
    # Buffer added/subtracted from the candle anchor (as % of mark price).
    # Keeps SL off the exact candle Low/High so a 1-pip wick doesn't stop out.
    buffer_pct: float
    # Maximum allowed SL distance as % of mark price.
    # If sl_dist > max_sl_pct × mark_price the trade is skipped — the candle
    # was too large and the 1:3 TP would be unreachably far away.
    max_sl_pct: float
    # Decimal places used for rounding returned levels.
    decimals: int


_CLASSES: dict[str, _InstrClass] = {
    "FX":      _InstrClass(buffer_pct=0.0003, max_sl_pct=0.025, decimals=5),
    "JPY":     _InstrClass(buffer_pct=0.0003, max_sl_pct=0.025, decimals=3),
    "METALS":  _InstrClass(buffer_pct=0.0015, max_sl_pct=0.030, decimals=3),
    "INDICES": _InstrClass(buffer_pct=0.0008, max_sl_pct=0.020, decimals=2),
    "CRYPTO":  _InstrClass(buffer_pct=0.0015, max_sl_pct=0.040, decimals=4),
}

# Oanda instrument → class
_OANDA_CLASS: dict[str, str] = {
    "USD_JPY": "JPY", "GBP_JPY": "JPY", "EUR_JPY": "JPY",
    "XAU_USD": "METALS", "XAG_USD": "METALS", "XPT_USD": "METALS",
    "NAS100_USD": "INDICES", "SPX500_USD": "INDICES", "US30_USD": "INDICES",
}
# All others default to "FX"

# Bybit symbols with large enough contract steps to warrant the crypto class
_BYBIT_CLASS: dict[str, str] = {}
# All Bybit symbols default to "CRYPTO"


def _get_class(instrument: str, is_bybit: bool = False) -> _InstrClass:
    if is_bybit:
        key = _BYBIT_CLASS.get(instrument, "CRYPTO")
    else:
        key = _OANDA_CLASS.get(instrument, "FX")
    return _CLASSES[key]


# ─────────────────────────────────────────────────────────────────────────────
#  Public API
# ─────────────────────────────────────────────────────────────────────────────

def candle_anchor_levels(
    candles:    list[Candle],
    mark_price: float,
    is_long:    bool,
    instrument: str,
    is_bybit:   bool = False,
    rr:         float = 3.0,
) -> tuple[float, float, float]:
    """
    Calculate SL, TP, and sl_dist using the Candle-Anchor method.

    Parameters
    ----------
    candles     : H1 candle list, oldest-first (same list fed to SMC engine).
                  Must have at least 2 complete candles.
    mark_price  : Current MarkPrice / live bid-ask midpoint.
    is_long     : True for Buy, False for Sell.
    instrument  : Oanda instrument string or Bybit symbol.
    is_bybit    : Set True for Bybit symbols (selects CRYPTO class).
    rr          : Risk-reward ratio for TP calculation (default 1:3).

    Returns
    -------
    (sl, tp, sl_dist) — all already validated and rounded.

    Raises
    ------
    ValueError  on any of:
      - fewer than 2 candles available
      - buffer calculation produces invalid geometry
      - sl_dist exceeds the max-SL safety gate
      - resulting SL/TP geometry is violated (sl ≮ price ≮ tp etc.)
    """
    if len(candles) < 2:
        raise ValueError(f"candle_anchor: need ≥2 candles, got {len(candles)}")

    # Previous candle = second-to-last in oldest-first list
    prev = candles[-2]
    cfg  = _get_class(instrument, is_bybit)
    buf  = mark_price * cfg.buffer_pct
    dp   = cfg.decimals

    if is_long:
        # SL below previous candle Low
        sl      = round(prev.low - buf, dp)
        sl_dist = mark_price - sl

        if sl_dist <= 0:
            raise ValueError(
                f"candle_anchor LONG {instrument}: prev.low {prev.low} >= mark {mark_price} "
                f"(price already below anchor — skip)"
            )

        tp = round(mark_price + rr * sl_dist, dp)

        # Geometry: SL < mark < TP
        if not (sl < mark_price < tp):
            raise ValueError(
                f"candle_anchor LONG {instrument}: geometry violated "
                f"sl={sl} mark={mark_price} tp={tp}"
            )
    else:
        # SL above previous candle High
        sl      = round(prev.high + buf, dp)
        sl_dist = sl - mark_price

        if sl_dist <= 0:
            raise ValueError(
                f"candle_anchor SHORT {instrument}: prev.high {prev.high} <= mark {mark_price} "
                f"(price already above anchor — skip)"
            )

        tp = round(mark_price - rr * sl_dist, dp)

        # Geometry: TP < mark < SL
        if not (tp < mark_price < sl):
            raise ValueError(
                f"candle_anchor SHORT {instrument}: geometry violated "
                f"tp={tp} mark={mark_price} sl={sl}"
            )

    # ── Safety gate: reject if SL distance is too large ──────────────────────
    # A very large candle (gap, news spike) can produce an sl_dist that would
    # require a tiny position size, making the 1:3 TP level unreachable within
    # the TTL.  Skip these rather than over-leveraging or wasting the trade.
    max_sl = mark_price * cfg.max_sl_pct
    if sl_dist > max_sl:
        raise ValueError(
            f"candle_anchor {instrument}: sl_dist {sl_dist:.5f} "
            f"({sl_dist / mark_price * 100:.2f}% of price) exceeds "
            f"max {cfg.max_sl_pct * 100:.1f}% — candle too large, skipping"
        )

    return sl, tp, sl_dist