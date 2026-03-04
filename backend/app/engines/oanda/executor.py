"""
app/engines/oanda/executor.py
==============================
Oanda v20 order placement, account queries, and auto-execution.

XAU_USD integer-unit enforcement: _compute_units() always returns int;
place_market_order() additionally coerces units to str(int(units)) before
the request body is built — belt-and-suspenders against any float path.
"""
from __future__ import annotations
import logging
from datetime import datetime

import httpx

from app.core.config import (
    OANDA_BASE, OANDA_MIN_UNITS, OANDA_SL_DECIMALS,
    get_oanda_creds,
)
from app.core.trade_tracker import trade_tracker
from app.core.alerts import push_notification
from app.services.strategy import Candle, TradeSignal

logger = logging.getLogger("fx-signal")


# ─────────────────────────────────────────────────────────────────────────────
#  Headers helpers
# ─────────────────────────────────────────────────────────────────────────────

def _headers(api_key: str) -> dict:
    return {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}


# ─────────────────────────────────────────────────────────────────────────────
#  Account / trade query helpers
# ─────────────────────────────────────────────────────────────────────────────

async def fetch_account_summary(api_key: str, account_id: str) -> dict:
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(f"{OANDA_BASE}/v3/accounts/{account_id}/summary", headers=_headers(api_key))
        r.raise_for_status()
    return r.json().get("account", {})


async def fetch_open_trades(api_key: str, account_id: str) -> list:
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(f"{OANDA_BASE}/v3/accounts/{account_id}/openTrades", headers=_headers(api_key))
        r.raise_for_status()
    trades = r.json().get("trades", [])
    # Deduplication: group by instrument, keep one entry per pair (most recent)
    seen: dict[str, dict] = {}
    for t in trades:
        ins = t.get("instrument", "")
        if ins not in seen:
            seen[ins] = t
        else:
            # Keep the trade with the higher (more recent) numeric ID
            if int(t.get("id", 0)) > int(seen[ins].get("id", 0)):
                seen[ins] = t
    return list(seen.values())


async def fetch_trade_history(api_key: str, account_id: str, count: int = 50) -> list:
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(
            f"{OANDA_BASE}/v3/accounts/{account_id}/trades",
            headers=_headers(api_key),
            params={"state": "CLOSED", "count": str(count)},
        )
        r.raise_for_status()
    return r.json().get("trades", [])


async def fetch_candles(instrument: str, granularity: str, count: int = 250) -> list[Candle]:
    key = __import__("os").environ.get("OANDA_API_KEY", "").strip()
    if not key:
        raise RuntimeError("OANDA_API_KEY not set")
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(
            f"{OANDA_BASE}/v3/instruments/{instrument}/candles",
            headers=_headers(key),
            params={"granularity": granularity, "count": count, "price": "M"},
        )
        r.raise_for_status()
    candles = []
    for cd in r.json().get("candles", []):
        if cd["complete"]:
            m = cd["mid"]
            candles.append(Candle(
                time   = int(datetime.fromisoformat(cd["time"].replace("Z", "+00:00")).timestamp()),
                open   = float(m["o"]), high=float(m["h"]),
                low    = float(m["l"]), close=float(m["c"]),
                volume = float(cd.get("volume", 0)),
            ))
    return candles


# ─────────────────────────────────────────────────────────────────────────────
#  Order placement
# ─────────────────────────────────────────────────────────────────────────────

def _compute_units(instrument: str, risk_usd: float, sl_dist: float, is_long: bool) -> int:
    """
    Compute Oanda unit size. Always returns a non-zero integer.
    XAU_USD / metals / indices: floor to minimum 1 unit.
    """
    if sl_dist <= 0:
        return 0
    raw     = risk_usd / sl_dist
    minimum = OANDA_MIN_UNITS.get(instrument, 1)
    units   = max(int(raw), minimum)
    return units if is_long else -units


async def place_market_order(
    api_key: str, account_id: str,
    instrument: str, units: int,
    stop_loss: float, take_profit: float,
) -> dict:
    sl_dec    = OANDA_SL_DECIMALS.get(instrument, 5)
    # CRITICAL: XAU_USD and all metals require integer unit strings — never "1.0"
    units_str = str(int(units))
    body      = {"order": {
        "type":       "MARKET",
        "instrument": instrument,
        "units":      units_str,
        "stopLossOnFill":   {"price": f"{stop_loss:.{sl_dec}f}"},
        "takeProfitOnFill": {"price": f"{take_profit:.{sl_dec}f}"},
        # timeInForce deliberately omitted — Oanda MARKET orders fill
        # immediately by default (equivalent to IOC).  Explicit "FOK"
        # causes MARKET_ORDER_REJECT on practice accounts and during
        # low-liquidity windows because Oanda can't guarantee a full
        # instantaneous fill, so the order is rejected outright.
    }}
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{OANDA_BASE}/v3/accounts/{account_id}/orders",
                         headers=_headers(api_key), json=body)
        r.raise_for_status()
    result = r.json()

    # ── Detect Oanda-level order rejection ────────────────────────────────────
    # A rejected order returns HTTP 201 (!) with an "orderRejectTransaction"
    # key instead of "orderFillTransaction".  raise_for_status() won't catch
    # this — we must inspect the body.  If we don't raise here the caller
    # reads the reject-transaction ID as the trade_id, locks the instrument
    # with a non-existent trade, and the watcher later 404s trying to close it.
    reject_tx = result.get("orderRejectTransaction")
    if reject_tx:
        reason = reject_tx.get("rejectReason") or reject_tx.get("type") or "MARKET_ORDER_REJECT"
        raise RuntimeError(f"Oanda order rejected: {reason} [{instrument}]")

    return result


async def close_trade(api_key: str, account_id: str, trade_id: str) -> dict:
    """PUT /v3/accounts/{id}/trades/{tradeSpecifier}/close — units=ALL."""
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.put(
            f"{OANDA_BASE}/v3/accounts/{account_id}/trades/{trade_id}/close",
            headers=_headers(api_key),
            json={"units": "ALL"},
        )
        r.raise_for_status()
    return r.json()


# ─────────────────────────────────────────────────────────────────────────────
#  Auto-execution at 100% confluence
# ─────────────────────────────────────────────────────────────────────────────

async def auto_execute(ins: str, sig_dict: dict, signal: TradeSignal) -> None:
    """
    Place a market order for a 100% confluence Oanda signal.
    On failure: sets sig_dict['exec_status']='failed' + exec_error so
    SignalsPage can immediately move the card to the History/Failed tab.
    """
    from app.database.user_vault import get_risk_pct

    if trade_tracker.is_locked(ins):
        logger.info("Oanda AutoExec: %s already locked — skip", ins)
        return

    creds = get_oanda_creds()
    if not creds:
        sig_dict["exec_status"] = "failed"
        sig_dict["exec_error"]  = "OANDA_API_KEY/ACCOUNT_ID not configured"
        return

    api_key, account_id = creds
    try:
        acct    = await fetch_account_summary(api_key, account_id)
        nav     = float(acct.get("NAV", 0) or 0)
        if nav <= 0:
            sig_dict["exec_status"] = "failed"
            sig_dict["exec_error"]  = "Oanda NAV is zero — check account"
            return

        # Use per-user risk if a clerk_id was embedded in sig_dict, else default
        clerk_id = sig_dict.get("clerk_id", "")
        risk_pct = get_risk_pct(clerk_id, "oanda") if clerk_id else 0.10
        risk_usd = nav * risk_pct

        is_long  = signal.direction.value == "LONG"
        entry    = signal.entry_price
        sl       = signal.stop_loss
        tp       = signal.take_profit

        # ── Pre-trade SL/TP geometry check ───────────────────────────────────
        # Oanda silently accepts an order where SL/TP are on the wrong side of
        # the entry price, but returns no orderFillTransaction (the order either
        # triggers immediately or is queued incorrectly).  Catch this before
        # touching the API — the strategy engine occasionally produces an
        # inverted signal during fast moves where the price has already passed
        # the intended entry level.
        #
        # LONG:  SL must be below entry, TP must be above entry
        # SHORT: SL must be above entry, TP must be below entry
        if is_long:
            geo_valid = sl < entry < tp
            geo_reason = f"LONG needs SL {sl:.5f} < entry {entry:.5f} < TP {tp:.5f}"
        else:
            geo_valid = sl > entry > tp
            geo_reason = f"SHORT needs SL {sl:.5f} > entry {entry:.5f} > TP {tp:.5f}"

        if not geo_valid:
            logger.warning(
                "Oanda AutoExec SKIPPED %s — SL/TP geometry invalid: %s",
                ins, geo_reason,
            )
            sig_dict["exec_status"] = "skipped"
            sig_dict["exec_error"]  = f"Skipped: SL/TP invalid vs entry ({geo_reason})"
            return

        sl_dist  = abs(entry - sl)
        units    = _compute_units(ins, risk_usd, sl_dist, is_long)
        if units == 0:
            sig_dict["exec_status"] = "failed"
            sig_dict["exec_error"]  = "Computed 0 units — SL distance too small"
            return

        trade_tracker.lock(ins, signal.direction.value, entry,
                           "pending", sl=sl, tp=tp)
        result   = await place_market_order(api_key, account_id, ins, units,
                                            sl, tp)

        # ── Extract the real trade ID from the fill transaction ───────────────
        # Oanda V20 order-fill response keys, in priority order:
        #   orderFillTransaction.tradeOpened.tradeID  — new trade opened
        #   orderFillTransaction.id                   — fill transaction ID
        #   orderCreateTransaction.id                 — order created (not filled yet)
        # We must use tradeID (not transaction ID) for close_trade() calls.
        fill_tx  = result.get("orderFillTransaction") or {}
        trade_id = (
            (fill_tx.get("tradeOpened") or {}).get("tradeID")
            or fill_tx.get("tradeID")
            or fill_tx.get("id")
            or ""
        )

        if not trade_id:
            # Order was accepted (no reject tx) but no fill transaction present.
            # This can happen for orders queued but not yet filled.
            # Unlock immediately — the reconciliation loop will pick it up.
            logger.warning("Oanda AutoExec %s: no tradeID in fill response — releasing lock", ins)
            trade_tracker.unlock(ins)
            sig_dict["exec_status"] = "failed"
            sig_dict["exec_error"]  = "Order accepted but no fill transaction returned"
            return

        trade_tracker.lock(ins, signal.direction.value, entry,
                           trade_id, sl=sl, tp=tp)

        sig_dict["exec_status"]   = "ok"
        sig_dict["exec_trade_id"] = trade_id
        sig_dict["exec_units"]    = units
        logger.info("✅ OANDA AUTO-EXEC: %s  units=%d  id=%s", ins, units, trade_id)

    except Exception as exc:
        err = str(exc)
        logger.error("Oanda AutoExec FAILED %s: %s", ins, err)
        trade_tracker.unlock(ins)
        sig_dict["exec_status"] = "failed"
        sig_dict["exec_error"]  = err