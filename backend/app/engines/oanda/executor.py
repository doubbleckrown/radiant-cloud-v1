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
from app.engines.sl_tp import candle_anchor_levels, oanda_units
import app.core.state as state

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

# _compute_units removed — replaced by oanda_units() in app/engines/sl_tp.py
# which correctly accounts for pip-value normalisation across all instrument classes.


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

        # ── Live price ───────────────────────────────────────────────────────
        # Use the streaming price (updated every tick).
        # Falls back to signal.entry_price only if stream has a gap.
        live_price = float(state.latest_prices.get(ins) or signal.entry_price)
        h1_candles = state.candle_cache.get(ins, {}).get("H1", [])

        # ── Zone-Anchored SL/TP (SMC-correct) ────────────────────────────────
        # Pass the OB/FVG zone object from the signal so the SL is anchored at
        # the institutional zone boundary, not an arbitrary recent candle.
        # This eliminates micro-stops caused by tight consolidation bars.
        #
        # The zone is carried in signal.layer2_zone_obj if the engine exposes it.
        # Falls back to None (previous-candle anchor with ATR floor) if absent.
        zone_obj   = getattr(signal, "layer2_zone_obj", None)

        try:
            sl, tp, sl_dist = candle_anchor_levels(
                candles    = h1_candles,
                mark_price = live_price,
                is_long    = is_long,
                instrument = ins,
                is_bybit   = False,
                zone       = zone_obj,
            )
        except ValueError as ve:
            logger.warning("Oanda AutoExec SKIPPED %s — SL/TP anchor: %s", ins, ve)
            sig_dict["exec_status"] = "skipped"
            sig_dict["exec_error"]  = f"Skipped: {ve}"
            return

        # ── Patch sig_dict so UI shows the ACTUAL filled levels ──────────────
        # Previously sig_dict showed signal.stop_loss/take_profit (stale signal-
        # time values). Now we overwrite with the live execution levels so the
        # displayed RR matches the order actually placed on the exchange.
        rr_actual = round(abs(tp - live_price) / abs(live_price - sl), 2) if sl != live_price else 0
        sig_dict["sl"] = sl
        sig_dict["tp"] = tp
        sig_dict["rr"] = rr_actual

        logger.info(
            "Oanda AutoExec %s %s: live=%.5f sl=%.5f tp=%.5f sl_dist=%.5f rr=1:%.2f",
            ins, "LONG" if is_long else "SHORT", live_price, sl, tp, sl_dist, rr_actual,
        )

        # ── Pip-value correct unit sizing ────────────────────────────────────
        # Replaces risk_usd / sl_dist which was only correct for USD-quote pairs.
        # oanda_units() normalises for JPY crosses, metals, and indices.
        try:
            units = oanda_units(
                instrument = ins,
                mark_price = live_price,
                sl_dist    = sl_dist,
                risk_usd   = risk_usd,
                is_long    = is_long,
            )
        except ValueError as ve:
            sig_dict["exec_status"] = "failed"
            sig_dict["exec_error"]  = f"Unit sizing error: {ve}"
            return

        if units == 0:
            sig_dict["exec_status"] = "failed"
            sig_dict["exec_error"]  = "Computed 0 units — SL distance too small"
            return

        trade_tracker.lock(ins, signal.direction.value, live_price,
                           "pending", sl=sl, tp=tp)
        result   = await place_market_order(api_key, account_id, ins, units,
                                            sl, tp)

        # ── Extract the real trade ID from the fill transaction ───────────────
        # Oanda V20 market order response shapes:
        #
        #  Immediate fill (normal):
        #    orderFillTransaction.tradeOpened.tradeID  ← what we need for close
        #
        #  Queued / not yet filled (happens on SPX500, indices during low liq):
        #    orderCreateTransaction present, orderFillTransaction absent
        #    The order is live but hasn't matched yet.
        #    → Poll open orders briefly, or accept the order ID and let the
        #      watcher reconcile once it fills.
        #
        #  Rejected (detected earlier by place_market_order, never reaches here)
        #    orderRejectTransaction present → RuntimeError already raised
        #
        # Log the full keys so future ambiguous cases are diagnosable.
        result_keys = list(result.keys()) if isinstance(result, dict) else []
        logger.debug("Oanda %s fill response keys: %s", ins, result_keys)

        fill_tx  = result.get("orderFillTransaction") or {}
        trade_id = (
            (fill_tx.get("tradeOpened") or {}).get("tradeID")
            or fill_tx.get("tradeID")
            or fill_tx.get("id")
            or ""
        )

        if not trade_id:
            # orderFillTransaction absent — order was accepted but not yet filled.
            # Grab the order ID from orderCreateTransaction so we can poll.
            create_tx = result.get("orderCreateTransaction") or {}
            order_id  = create_tx.get("id", "")

            if order_id:
                # Give Oanda up to 3 seconds to fill (indices can be slow).
                import asyncio as _aio
                for attempt in range(3):
                    await _aio.sleep(1.0)
                    try:
                        open_trades = await fetch_open_trades(api_key, account_id)
                        match = next((t for t in open_trades if t.get("instrument") == ins), None)
                        if match:
                            trade_id = str(match.get("id", ""))
                            logger.info(
                                "Oanda AutoExec %s: fill confirmed on poll attempt %d — tradeID=%s",
                                ins, attempt + 1, trade_id,
                            )
                            break
                    except Exception as poll_exc:
                        logger.warning("Oanda fill poll %s attempt %d: %s", ins, attempt + 1, poll_exc)

            if not trade_id:
                logger.warning(
                    "Oanda AutoExec %s: no tradeID after polling — response keys=%s orderID=%s",
                    ins, result_keys, order_id,
                )
                trade_tracker.unlock(ins)
                sig_dict["exec_status"] = "failed"
                sig_dict["exec_error"]  = (
                    f"Order {'queued (ID=' + order_id + ') but did not fill within 3s' if order_id else 'accepted with no fill transaction'}"
                )
                return

        trade_tracker.lock(ins, signal.direction.value, live_price,
                           trade_id, sl=sl, tp=tp)

        sig_dict.update({
            "exec_status":   "ok",
            "exec_trade_id": trade_id,
            "exec_units":    units,
            "exec_sl":       sl,
            "exec_tp":       tp,
            "exec_price":    live_price,
        })
        logger.info("✅ OANDA AUTO-EXEC: %s  units=%d  id=%s  sl=%.5f  tp=%.5f",
                    ins, units, trade_id, sl, tp)

    except Exception as exc:
        err = str(exc)
        logger.error("Oanda AutoExec FAILED %s: %s", ins, err)
        trade_tracker.unlock(ins)
        sig_dict["exec_status"] = "failed"
        sig_dict["exec_error"]  = err