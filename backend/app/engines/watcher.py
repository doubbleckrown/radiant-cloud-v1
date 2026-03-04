"""
app/engines/watcher.py — Unified TP/SL/TTL exit monitor (30-second sweep).

Priority per lock:
  1. TTL   — opened_at + ttl_seconds elapsed → force market close
  2. TP    — LONG: price >= tp  |  SHORT: price <= tp
  3. SL    — LONG: price <= sl  |  SHORT: price >= sl

Price sources:
  Bybit  → state.bybit_prices  (updated 60s by bybit engine)
  Oanda  → state.latest_prices (real-time SSE)

Fires typed push notifications AFTER each close so the device sound matches
the exit reason.
"""
from __future__ import annotations
import asyncio
import logging
import time

import httpx

import app.core.state as state
from app.core.config import TRADE_LOCK_TTL_SECONDS, EXIT_MONITOR_INTERVAL, get_bybit_creds, get_oanda_creds
from app.core.trade_tracker import trade_tracker
from app.core.alerts import push_notification

logger = logging.getLogger("fx-signal")


# ─────────────────────────────────────────────────────────────────────────────
#  Engine-specific close helpers
# ─────────────────────────────────────────────────────────────────────────────

async def _close_bybit(symbol: str, lock: dict, reason: str) -> None:
    from app.engines.bybit.executor import fetch_positions, close_position
    creds = get_bybit_creds()
    if not creds:
        logger.error("[EXIT] Bybit creds missing — cannot close %s (%s)", symbol, reason)
        return
    api_key, secret = creds
    try:
        positions = await fetch_positions(api_key, secret)
        pos = next((p for p in positions if p.get("symbol") == symbol), None)
        if not pos:
            logger.info("[EXIT] %s already closed on exchange (%s)", symbol, reason)
            trade_tracker.unlock(symbol)
            return
        await close_position(api_key, secret, symbol, pos.get("side", "Buy"), str(pos.get("size", "0")))
        trade_tracker.unlock(symbol)
        logger.info("[EXIT] Closed Bybit %s — %s", symbol, reason)
    except Exception as exc:
        logger.error("[EXIT] Bybit close failed %s (%s): %s", symbol, reason, exc)


async def _close_oanda(ins: str, lock: dict, reason: str) -> None:
    from app.engines.oanda.executor import close_trade, fetch_open_trades
    creds = get_oanda_creds()
    if not creds:
        logger.error("[EXIT] Oanda creds missing — cannot close %s (%s)", ins, reason)
        return
    api_key, account_id = creds
    trade_id = lock.get("trade_id", "")
    try:
        if trade_id and trade_id != "pending":
            try:
                await close_trade(api_key, account_id, trade_id)
                logger.info("[EXIT] Closed Oanda %s — %s  id=%s", ins, reason, trade_id)
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 404:
                    # Trade doesn't exist on Oanda — it was either:
                    #   a) A rejected order whose transaction ID was stored instead
                    #      of a real trade ID (MARKET_ORDER_REJECT bug)
                    #   b) Already closed manually or by Oanda's own SL/TP
                    # Either way the position is gone — unlock and move on.
                    logger.warning(
                        "[EXIT] Oanda %s trade %s not found (404) — "
                        "already closed or was a rejected order. Releasing lock. (%s)",
                        ins, trade_id, reason,
                    )
                else:
                    raise  # re-raise non-404 HTTP errors
            trade_tracker.unlock(ins)
        else:
            # trade_id is "pending" or empty — order may have been placed but
            # fill transaction was never confirmed. Look up by instrument instead.
            trades = await fetch_open_trades(api_key, account_id)
            matching = [t for t in trades if t.get("instrument") == ins]
            if not matching:
                logger.info("[EXIT] %s already closed on exchange (%s)", ins, reason)
                trade_tracker.unlock(ins)
                return
            for t in matching:
                tid = str(t.get("id", ""))
                if tid:
                    try:
                        await close_trade(api_key, account_id, tid)
                        logger.info("[EXIT] Closed Oanda %s — %s  id=%s (lookup)", ins, reason, tid)
                    except httpx.HTTPStatusError as e:
                        if e.response.status_code == 404:
                            logger.warning("[EXIT] Oanda %s trade %s not found on close (lookup) — skipping", ins, tid)
                        else:
                            raise
            trade_tracker.unlock(ins)
    except Exception as exc:
        logger.error("[EXIT] Oanda close failed %s (%s): %s", ins, reason, exc)
        # Still unlock — a permanent ghost lock blocks all future signals for
        # this instrument.  If the trade was real, the reconciliation loop
        # (trade_reconciliation_loop) will detect no live position and confirm.
        trade_tracker.unlock(ins)


# ─────────────────────────────────────────────────────────────────────────────
#  Main watcher loop
# ─────────────────────────────────────────────────────────────────────────────

async def exit_monitor_loop() -> None:
    """Background watcher — sweeps every EXIT_MONITOR_INTERVAL seconds."""
    await asyncio.sleep(20)   # startup grace period

    while True:
        try:
            locks = trade_tracker.all_locks()
            now   = time.time()

            for symbol, lock in list(locks.items()):
                direction = lock.get("direction", "LONG")
                sl        = float(lock.get("sl",       0) or 0)
                tp        = float(lock.get("tp",       0) or 0)
                opened_at = float(lock.get("opened_at", now) or now)
                is_bybit  = symbol.endswith("USDT")

                price = (state.bybit_prices if is_bybit else state.latest_prices).get(symbol, 0.0)
                if price <= 0:
                    continue

                sym_label = symbol.replace("_", "/").replace("USDT", "/USDT")
                dp        = 4 if is_bybit else 5

                # ── 1. TTL ────────────────────────────────────────────────
                age_s = now - opened_at
                if age_s >= TRADE_LOCK_TTL_SECONDS:
                    reason = f"TTL (2h expired; age={int(age_s)}s)"
                    logger.warning("[EXIT] %s — TTL  age=%ds  price=%.5f", symbol, int(age_s), price)
                    if is_bybit:
                        await _close_bybit(symbol, lock, reason)
                    else:
                        await _close_oanda(symbol, lock, reason)
                    asyncio.create_task(push_notification(
                        "ttl", "⏱ 2h Timer Expired",
                        f"⏱ 2h Timer Expired. {sym_label} closed at Market Price.",
                        {"instrument": symbol, "price": round(price, dp), "age_s": int(age_s)},
                    ))
                    continue

                # ── 2. Take-Profit ────────────────────────────────────────
                if tp > 0:
                    tp_hit = (direction == "LONG" and price >= tp) or (direction == "SHORT" and price <= tp)
                    if tp_hit:
                        cmp    = ">=" if direction == "LONG" else "<="
                        reason = f"TP hit (price {price:.{dp}f} {cmp} tp {tp:.{dp}f})"
                        logger.info("[EXIT] %s — TP  price=%.5f  tp=%.5f  dir=%s", symbol, price, tp, direction)
                        if is_bybit:
                            await _close_bybit(symbol, lock, reason)
                        else:
                            await _close_oanda(symbol, lock, reason)
                        asyncio.create_task(push_notification(
                            "tp", f"💰 Take Profit Hit! {sym_label}",
                            f"💰 Take Profit Hit! {sym_label} closed at {price:.{dp}f}.",
                            {"instrument": symbol, "price": round(price, dp), "tp": round(tp, dp), "direction": direction},
                        ))
                        continue

                # ── 3. Stop-Loss ──────────────────────────────────────────
                if sl > 0:
                    sl_hit = (direction == "LONG" and price <= sl) or (direction == "SHORT" and price >= sl)
                    if sl_hit:
                        cmp    = "<=" if direction == "LONG" else ">="
                        reason = f"SL hit (price {price:.{dp}f} {cmp} sl {sl:.{dp}f})"
                        logger.info("[EXIT] %s — SL  price=%.5f  sl=%.5f  dir=%s", symbol, price, sl, direction)
                        if is_bybit:
                            await _close_bybit(symbol, lock, reason)
                        else:
                            await _close_oanda(symbol, lock, reason)
                        asyncio.create_task(push_notification(
                            "sl", f"📉 Stop Loss Hit. {sym_label}",
                            f"📉 Stop Loss Hit. {sym_label} closed at {price:.{dp}f}.",
                            {"instrument": symbol, "price": round(price, dp), "sl": round(sl, dp), "direction": direction},
                        ))

        except Exception as exc:
            logger.error("exit_monitor_loop error: %s", exc)

        await asyncio.sleep(EXIT_MONITOR_INTERVAL)