"""
fx-signal — Oanda Watcher
Background loops:
  price_stream_loop   — SSE real-time tick stream
  oanda_exit_monitor  — every 30s: TP/SL/TTL enforcement for Oanda trades
  oanda_reconciliation_loop — every 5 min: ghost-trade cleanup
"""
from __future__ import annotations
import asyncio
import json
import logging
import time
import httpx
from app.core.config import (
    OANDA_BASE, OANDA_STREAM, INSTRUMENTS,
    TRADE_LOCK_TTL_SECONDS, EXIT_MONITOR_INTERVAL,
    oanda_credentials_ok, get_oanda_creds,
)
from app.core.state import latest_prices, ws_clients
from app.core.trade_tracker import trade_tracker
from app.core import alerts
from app.engines.oanda.executor import fetch_open_trades, close_trade

logger = logging.getLogger("fx-signal.oanda.watcher")


async def price_stream_loop() -> None:
    """SSE price stream — updates latest_prices in real-time."""
    import os
    while True:
        if not oanda_credentials_ok():
            logger.warning("price_stream_loop: credentials missing — retry in 30s")
            await asyncio.sleep(30)
            continue

        key              = os.environ.get("OANDA_API_KEY", "").strip()
        account_id       = os.environ.get("OANDA_ACCOUNT_ID", "").strip()
        instruments_param = "%2C".join(INSTRUMENTS)
        url = f"{OANDA_STREAM}/v3/accounts/{account_id}/pricing/stream?instruments={instruments_param}"

        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("GET", url, headers={"Authorization": f"Bearer {key}"}) as resp:
                    async for line in resp.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            tick = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if tick.get("type") == "PRICE":
                            ins = tick["instrument"]
                            bid = float(tick["bids"][0]["price"])
                            ask = float(tick["asks"][0]["price"])
                            mid = round((bid + ask) / 2, 5)
                            latest_prices[ins] = mid

                            # Broadcast to WebSocket clients
                            from app.routes.routes_ws import broadcast
                            await broadcast({
                                "type": "TICK", "instrument": ins,
                                "bid": bid, "ask": ask, "mid": mid, "time": tick["time"],
                            })
        except Exception as exc:
            logger.error("Oanda stream error: %s — reconnecting in 5s", exc)
            await asyncio.sleep(5)


async def oanda_exit_monitor() -> None:
    """
    Sweeps every 30 seconds.
    Priority: TTL → TP → SL (Oanda side only — Bybit watcher handles USDT perps).
    """
    await asyncio.sleep(20)
    while True:
        try:
            locks = trade_tracker.all_locks()
            now   = time.time()

            for symbol, lock in list(locks.items()):
                if symbol.endswith("USDT"):
                    continue   # Bybit watcher handles these

                direction = lock.get("direction", "LONG")
                sl        = float(lock.get("sl", 0) or 0)
                tp        = float(lock.get("tp", 0) or 0)
                opened_at = float(lock.get("opened_at", now) or now)
                price     = latest_prices.get(symbol, 0.0)

                if price <= 0:
                    continue

                age_s = now - opened_at

                # ── 1. Hard TTL ─────────────────────────────────────────────
                if age_s >= TRADE_LOCK_TTL_SECONDS:
                    reason = f"TTL (2h expired; opened {int(age_s)}s ago)"
                    logger.warning("[EXIT] %s — TTL  age=%ds  price=%.5f", symbol, int(age_s), price)
                    await _force_close_oanda(symbol, lock, reason)
                    await alerts.alert_ttl_close(symbol, price, int(age_s))
                    continue

                # ── 2. Take-profit ──────────────────────────────────────────
                if tp > 0:
                    tp_hit = (direction == "LONG" and price >= tp) or (direction == "SHORT" and price <= tp)
                    if tp_hit:
                        reason = f"TP hit (price {price:.5f} tp {tp:.5f})"
                        logger.info("[EXIT] %s — TP  price=%.5f  tp=%.5f", symbol, price, tp)
                        await _force_close_oanda(symbol, lock, reason)
                        await alerts.alert_take_profit(symbol, price, tp, direction, is_bybit=False)
                        continue

                # ── 3. Stop-loss ────────────────────────────────────────────
                if sl > 0:
                    sl_hit = (direction == "LONG" and price <= sl) or (direction == "SHORT" and price >= sl)
                    if sl_hit:
                        reason = f"SL hit (price {price:.5f} sl {sl:.5f})"
                        logger.info("[EXIT] %s — SL  price=%.5f  sl=%.5f", symbol, price, sl)
                        await _force_close_oanda(symbol, lock, reason)
                        await alerts.alert_stop_loss(symbol, price, sl, direction, is_bybit=False)

        except Exception as exc:
            logger.error("oanda_exit_monitor error: %s", exc)

        await asyncio.sleep(EXIT_MONITOR_INTERVAL)


async def _force_close_oanda(ins: str, lock: dict, reason: str) -> None:
    """Close via stored trade_id; falls back to instrument scan."""
    creds = get_oanda_creds()
    if not creds:
        logger.error("[EXIT] Oanda creds missing — cannot close %s", ins)
        return
    api_key, account_id = creds
    trade_id = lock.get("trade_id", "")
    try:
        if trade_id and trade_id != "pending":
            await close_trade(api_key, account_id, trade_id)
            trade_tracker.unlock(ins)
            logger.info("[EXIT] Closed %s — %s  trade_id=%s", ins, reason, trade_id)
        else:
            # Fallback: find by instrument
            trades   = await fetch_open_trades(api_key, account_id)
            matching = [t for t in trades if t.get("instrument") == ins]
            if not matching:
                logger.info("[EXIT] %s already closed on exchange (%s)", ins, reason)
                trade_tracker.unlock(ins)
                return
            for t in matching:
                tid = str(t.get("id", ""))
                if tid:
                    await close_trade(api_key, account_id, tid)
                    logger.info("[EXIT] Closed %s — %s  trade_id=%s (scan)", ins, reason, tid)
            trade_tracker.unlock(ins)
    except Exception as exc:
        logger.error("[EXIT] Failed to close Oanda %s (%s): %s", ins, reason, exc)


async def oanda_reconciliation_loop() -> None:
    """Ghost-trade cleanup — runs every 5 minutes."""
    INTERVAL = 300
    await asyncio.sleep(60)
    while True:
        try:
            creds = get_oanda_creds()
            if creds:
                locks         = trade_tracker.all_locks()
                oanda_locked  = [s for s in locks if "_" in s and not s.endswith("USDT")]
                live_trades   = await fetch_open_trades(*creds)
                live_oanda    = {t.get("instrument", "") for t in live_trades}
                for ins in oanda_locked:
                    if ins not in live_oanda:
                        trade_tracker.unlock(ins)
                        logger.warning("🔓 Reconciliation: Oanda %s released (no live trade)", ins)
        except Exception as exc:
            logger.debug("Oanda reconciliation error: %s", exc)
        await asyncio.sleep(INTERVAL)
