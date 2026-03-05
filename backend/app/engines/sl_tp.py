"""
app/engines/sl_tp.py
====================
SMC Candle-Anchor SL/TP Calculator — shared by Oanda and Bybit executors.

Method (updated — Structural Zone Anchor)
-----------------------------------------
The previous implementation used candles[-2] (the most recent completed H1
candle) as the SL anchor for every trade regardless of what created the signal.
That produced micro-stops whenever the preceding candle was a small
consolidation bar — a 5-pip range candle produces a 5-pip stop, which is
purely noise on H1.

The correct SMC approach uses the ORDER BLOCK or FAIR VALUE GAP zone that
triggered the signal as the invalidation anchor:

  Buy  (LONG) — price inside bullish OB/FVG:
    SL  = zone_low  - buffer            (below the institutional zone)
    TP  = mark_price + rr × (mark_price - SL)

  Sell (SHORT) — price inside bearish OB/FVG:
    SL  = zone_high + buffer            (above the institutional zone)
    TP  = mark_price - rr × (SL - mark_price)

Fallback (no zone object available):
    Use the previous candle's Low/High, but only if sl_dist ≥ ATR_FLOOR so
    tight consolidation candles are rejected before they produce micro-stops.

Position sizing (Bybit + Oanda)
--------------------------------
Both sizing formulas are documented here; the executors import them.

  Bybit linear perpetuals (USDT-settled):
    qty = risk_usd / sl_dist      ← contracts whose P&L is $1 per $1 move
    margin = qty × mark_price / lev

  Oanda:
    units = risk_usd / (sl_pips × pip_value_usd)
    where pip_value_usd is the USD value of 1 pip for 1 unit of the instrument.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Optional

from app.services.strategy import Candle, OrderBlock, FairValueGap


# ─────────────────────────────────────────────────────────────────────────────
#  Instrument-class configuration
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class _InstrClass:
    buffer_pct:  float   # SL buffer beyond zone (% of mark price)
    max_sl_pct:  float   # Safety gate: max allowed SL distance (% of mark)
    atr_floor_pct: float # Minimum SL distance — rejects micro-stops (% of mark)
    pip_size:    float   # Size of 1 pip in price units (used by Oanda sizing)
    decimals:    int     # Rounding precision for SL/TP output


_CLASSES: dict[str, _InstrClass] = {
    #               buffer   max_sl  atr_floor  pip_sz   dp
    "FX":      _InstrClass(0.0003,  0.025,  0.0008,  0.0001,  5),
    "JPY":     _InstrClass(0.0003,  0.025,  0.0008,  0.01,    3),
    "METALS":  _InstrClass(0.0015,  0.030,  0.0020,  0.10,    2),
    "INDICES": _InstrClass(0.0008,  0.020,  0.0015,  1.0,     1),
    "CRYPTO":  _InstrClass(0.0015,  0.040,  0.0020,  1.0,     4),
}

# ── Oanda instrument → class ──────────────────────────────────────────────────
_OANDA_CLASS: dict[str, str] = {
    "USD_JPY": "JPY", "GBP_JPY": "JPY", "EUR_JPY": "JPY",
    "XAU_USD": "METALS", "XAG_USD": "METALS", "XPT_USD": "METALS",
    "NAS100_USD": "INDICES", "SPX500_USD": "INDICES", "US30_USD": "INDICES",
}
# All other Oanda instruments default to "FX"

# ── Oanda pip value (USD per 1 pip per 1 unit) ─────────────────────────────────
# For USD-quote pairs (EUR/USD etc.): 1 unit moves $0.0001 per pip → pip_val = 0.0001
# For JPY-quote pairs (USD/JPY etc.): 1 pip = ¥0.01; pip_val = 0.01 / USD_JPY_rate
#   → approximated as 0.01 / price, evaluated at runtime
# For USD-base pairs (USD/CAD, USD/CHF): pip_val = 0.0001 / price
# Metals / indices: move is in USD directly → pip_val = pip_size (1.0 for SPX etc.)
#
# Stored as a callable (takes mark_price) or a float constant.
_OANDA_PIP_VALUE: dict[str, float | callable] = {
    # USD-quote majors: pip value is fixed (quote currency IS USD)
    "EUR_USD": 0.0001, "GBP_USD": 0.0001, "AUD_USD": 0.0001,
    "NZD_USD": 0.0001,
    # USD-base pairs: pip value = 0.0001 / mark_price (quote currency not USD)
    "USD_JPY":  lambda p: 0.01   / p,   # ¥0.01 pip → ÷ USD/JPY rate
    "USD_CAD":  lambda p: 0.0001 / p,
    "USD_CHF":  lambda p: 0.0001 / p,
    # Cross pairs (neither leg is USD) — approximated; ideally use live FX rates
    "EUR_GBP":  lambda p: 0.0001 / p,   # pips in GBP → ÷ GBP/USD ≈ 1/p (rough)
    "GBP_JPY":  lambda p: 0.01   / p,
    "EUR_JPY":  lambda p: 0.01   / p,
    "AUD_CAD":  lambda p: 0.0001 / p,
    # Metals: pip = $0.10 for silver, $0.01 for gold (treat as $1 per pt)
    "XAU_USD": 1.0, "XAG_USD": 0.10, "XPT_USD": 1.0,
    # Indices: $1 per point per unit
    "NAS100_USD": 1.0, "SPX500_USD": 1.0, "US30_USD": 1.0,
}


def _get_class(instrument: str, is_bybit: bool = False) -> _InstrClass:
    if is_bybit:
        return _CLASSES["CRYPTO"]
    return _CLASSES[_OANDA_CLASS.get(instrument, "FX")]


def _pip_value_usd(instrument: str, mark_price: float) -> float:
    """Return USD value of 1 pip for 1 unit of the given Oanda instrument."""
    pv = _OANDA_PIP_VALUE.get(instrument, 0.0001)
    return pv(mark_price) if callable(pv) else pv


# ─────────────────────────────────────────────────────────────────────────────
#  Core SL/TP calculation
# ─────────────────────────────────────────────────────────────────────────────

def candle_anchor_levels(
    candles:    list[Candle],
    mark_price: float,
    is_long:    bool,
    instrument: str,
    is_bybit:   bool = False,
    rr:         float = 3.0,
    zone: Optional[OrderBlock | FairValueGap] = None,
) -> tuple[float, float, float]:
    """
    Calculate SL, TP, and sl_dist using the SMC Zone Anchor method.

    Parameters
    ----------
    candles     : H1 candle list, oldest-first. Needs ≥2 candles.
    mark_price  : Current live price (MarkPrice for Bybit, bid-ask mid for Oanda).
    is_long     : True for Buy, False for Sell.
    instrument  : Oanda instrument string or Bybit symbol.
    is_bybit    : Selects CRYPTO instrument class.
    rr          : Risk-reward ratio (default 1:3).
    zone        : The OB or FVG object from the SMC signal (preferred anchor).
                  If None falls back to previous-candle Low/High with ATR floor.

    Returns
    -------
    (sl, tp, sl_dist) — validated, rounded.

    Raises
    ------
    ValueError on geometry violation, ATR-floor rejection, or safety-gate breach.
    """
    if len(candles) < 2:
        raise ValueError(f"candle_anchor: need ≥2 candles, got {len(candles)}")

    cfg = _get_class(instrument, is_bybit)
    buf = mark_price * cfg.buffer_pct
    dp  = cfg.decimals

    # ── Determine the structural anchor ──────────────────────────────────────
    if zone is not None:
        # PRIMARY: use the OB/FVG zone boundaries as the invalidation level.
        # For a LONG inside a bullish OB/FVG, the thesis is invalidated if
        # price closes below the zone's low. SL = zone_low - buffer.
        # For a SHORT inside a bearish OB/FVG, SL = zone_high + buffer.
        if is_long:
            if isinstance(zone, OrderBlock):
                anchor = zone.ob_low
            else:   # FairValueGap
                anchor = zone.gap_low
            sl = round(anchor - buf, dp)
        else:
            if isinstance(zone, OrderBlock):
                anchor = zone.ob_high
            else:
                anchor = zone.gap_high
            sl = round(anchor + buf, dp)
    else:
        # FALLBACK: previous candle Low/High (original method).
        prev   = candles[-2]
        anchor = prev.low if is_long else prev.high
        sl     = round((anchor - buf) if is_long else (anchor + buf), dp)

    # ── Compute sl_dist and TP ────────────────────────────────────────────────
    if is_long:
        sl_dist = mark_price - sl
    else:
        sl_dist = sl - mark_price

    if sl_dist <= 0:
        raise ValueError(
            f"candle_anchor {'LONG' if is_long else 'SHORT'} {instrument}: "
            f"sl_dist={sl_dist:.5f} ≤ 0 — anchor ({anchor:.5f}) is on the wrong "
            f"side of mark_price ({mark_price:.5f})"
        )

    # ── ATR floor: reject micro-stops ─────────────────────────────────────────
    # If sl_dist is smaller than the ATR floor, the stop is inside normal H1 noise.
    # This catches fallback candles that are tight consolidation bars.
    min_sl = mark_price * cfg.atr_floor_pct
    if sl_dist < min_sl:
        raise ValueError(
            f"candle_anchor {instrument}: sl_dist {sl_dist:.5f} "
            f"({sl_dist / mark_price * 100:.3f}% of price) is below ATR floor "
            f"{cfg.atr_floor_pct * 100:.2f}% — stop would be a micro-stop, skipping"
        )

    # ── Safety gate: reject over-large stops ─────────────────────────────────
    max_sl = mark_price * cfg.max_sl_pct
    if sl_dist > max_sl:
        raise ValueError(
            f"candle_anchor {instrument}: sl_dist {sl_dist:.5f} "
            f"({sl_dist / mark_price * 100:.2f}%) exceeds max {cfg.max_sl_pct * 100:.1f}% "
            f"— candle/zone too large, skipping"
        )

    # ── TP at 1:rr ────────────────────────────────────────────────────────────
    if is_long:
        tp = round(mark_price + rr * sl_dist, dp)
    else:
        tp = round(mark_price - rr * sl_dist, dp)

    # ── Final geometry assertion ──────────────────────────────────────────────
    if is_long and not (sl < mark_price < tp):
        raise ValueError(
            f"candle_anchor LONG {instrument}: geometry violated "
            f"sl={sl} mark={mark_price} tp={tp}"
        )
    if not is_long and not (tp < mark_price < sl):
        raise ValueError(
            f"candle_anchor SHORT {instrument}: geometry violated "
            f"tp={tp} mark={mark_price} sl={sl}"
        )

    return sl, tp, sl_dist


# ─────────────────────────────────────────────────────────────────────────────
#  Oanda unit sizing
# ─────────────────────────────────────────────────────────────────────────────

def oanda_units(
    instrument: str,
    mark_price: float,
    sl_dist:    float,
    risk_usd:   float,
    is_long:    bool,
) -> int:
    """
    Calculate the correct Oanda unit count so that the P&L at the stop loss
    equals exactly risk_usd.

    Formula (corrected):
        pip_val = USD value of 1 pip for 1 unit of the instrument
        pip_size = price distance of 1 pip for this instrument
        sl_pips  = sl_dist / pip_size
        units    = risk_usd / (sl_pips × pip_val)

    The previous formula (risk_usd / sl_dist) was only correct for USD-quote
    pairs (EUR/USD, GBP/USD). For USD/JPY it produced 110× too few units;
    for indices it produced the right risk but inflated margin consumption.
    """
    cfg      = _get_class(instrument, is_bybit=False)
    pip_sz   = cfg.pip_size
    pip_val  = _pip_value_usd(instrument, mark_price)

    if pip_sz <= 0 or pip_val <= 0:
        raise ValueError(f"oanda_units: invalid pip_sz={pip_sz} or pip_val={pip_val} for {instrument}")

    sl_pips = sl_dist / pip_sz
    if sl_pips <= 0:
        raise ValueError(f"oanda_units: sl_pips={sl_pips:.4f} ≤ 0 for {instrument}")

    raw   = risk_usd / (sl_pips * pip_val)
    from app.core.config import OANDA_MIN_UNITS
    minimum = OANDA_MIN_UNITS.get(instrument, 1)
    units = max(int(raw), minimum)
    return units if is_long else -units


# ─────────────────────────────────────────────────────────────────────────────
#  Bybit quantity sizing
# ─────────────────────────────────────────────────────────────────────────────

def bybit_qty(
    risk_usd:   float,
    sl_dist:    float,
    mark_price: float,
    leverage:   int,
    available:  float,
) -> tuple[float, float]:
    """
    Calculate the correct contract quantity for a Bybit linear USDT perpetual
    so that the unrealised P&L at the stop loss equals exactly risk_usd.

    For linear perps: P&L = qty × price_move (in USDT, 1:1).
    Therefore: qty = risk_usd / sl_dist   (no leverage in this formula).

    Leverage only governs the initial margin consumed:
        margin = qty × mark_price / leverage

    If the required margin exceeds 90% of available balance, qty is scaled down
    proportionally so the margin fits within the free balance.

    Returns
    -------
    (qty, margin_used)
    """
    if sl_dist <= 0:
        raise ValueError(f"bybit_qty: sl_dist={sl_dist} ≤ 0")
    if risk_usd <= 0:
        raise ValueError(f"bybit_qty: risk_usd={risk_usd} ≤ 0")

    qty_raw = risk_usd / sl_dist

    # Compute the initial margin this position would require
    margin_raw = qty_raw * mark_price / leverage

    # Cap: never consume more than 90% of available free balance
    max_margin = available * 0.90
    if margin_raw > max_margin:
        # Scale qty down so margin fits
        qty_raw    = (max_margin * leverage) / mark_price
        margin_raw = max_margin

    return qty_raw, margin_raw