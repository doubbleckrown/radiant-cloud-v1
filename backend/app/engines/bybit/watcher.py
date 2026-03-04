"""
fx-signal — Bybit Watcher
Background loops:
  exit_monitor_loop    — every 30s: TP/SL/TTL enforcement for Bybit positions
  reconciliation_loop  — every 5 min: ghost-trade cleanup
"""
from __future__ import annotations
import asyncio
import logging
import time
from app.core.config import TRADE_LOCK_TTL_SECONDS, EXIT_MONITOR_INTERVAL, get_bybit_creds
from app.core.state import bybit_prices
from app.core.trade_tracker import trade_tracker
from app.core import alerts
from app.engines.bybit.executor import fetch_positions, close_position

logger = logging.getLogger("fx-signal.bybit.watcher")


async def _force_close(sym: str, lock: dict, reason: str) -> None:
    """Fetch live position size/side then market-close it."""
    creds = get_bybit_creds()
    if not creds:
        logger.error("[EXIT] Bybit creds missing — cannot close %s (%s)", sym, reason)
        return
    api_key, api_secret = creds
    try:
        positions = await fetch_positions(api_key, api_secret)
        pos = next((p for p in positions if p.get("symbol") == sym), None)
        if not pos:
            logger.info("[EXIT] %s already gone on exchange (%s)", sym, reason)
            trade_tracker.unlock(sym)
            return
        size = str(pos.get("size", "0"))
        side = pos.get("side", "Buy")
        await close_position(api_key, api_secret, sym, side, size)
        trade_tracker.unlock(sym)
        logger.info("[EXIT] Closed %s — %s  size=%s", sym, reason, size)
    except Exception as exc:
        logger.error("[EXIT] Failed to close Bybit %s (%s): %s", sym, reason, exc)


async def bybit_exit_monitor() -> None:
    """
    Sweeps every 30 seconds.
    Priority: TTL → TP → SL
    Fires typed push notification on every exit.
    """
    await asyncio.sleep(20)   # let price streams warm up first
    while True:
        try:
            locks = trade_tracker.all_locks()
            now   = time.time()
            for symbol, lock in list(locks.items()):
                if not symbol.endswith("USDT"):
                    continue   # Bybit watcher only handles USDT perpetuals

                direction = lock.get("direction", "LONG")
                sl        = float(lock.get("sl", 0) or 0)
                tp        = float(lock.get("tp", 0) or 0)
                opened_at = float(lock.get("opened_at", now) or now)
                price     = bybit_prices.get(symbol, 0.0)

                if price <= 0:
                    continue

                age_s = now - opened_at

                # ── 1. Hard 2-hour TTL ──────────────────────────────────────
                if age_s >= TRADE_LOCK_TTL_SECONDS:
                    reason = f"TTL (2h expired; opened {int(age_s)}s ago)"
                    logger.warning("[EXIT] %s — TTL  age=%ds  price=%.4f", symbol, int(age_s), price)
                    await _force_close(symbol, lock, reason)
                    await alerts.alert_ttl_close(symbol, price, int(age_s))
                    continue

                # ── 2. Take-profit ──────────────────────────────────────────
                if tp > 0:
                    tp_hit = (direction == "LONG" and price >= tp) or (direction == "SHORT" and price <= tp)
                    if tp_hit:
                        reason = f"TP hit (price {price:.4f} tp {tp:.4f})"
                        logger.info("[EXIT] %s — TP  price=%.4f  tp=%.4f", symbol, price, tp)
                        await _force_close(symbol, lock, reason)
                        await alerts.alert_take_profit(symbol, price, tp, direction, is_bybit=True)
                        continue

                # ── 3. Stop-loss ────────────────────────────────────────────
                if sl > 0:
                    sl_hit = (direction == "LONG" and price <= sl) or (direction == "SHORT" and price >= sl)
                    if sl_hit:
                        reason = f"SL hit (price {price:.4f} sl {sl:.4f})"
                        logger.info("[EXIT] %s — SL  price=%.4f  sl=%.4f", symbol, price, sl)
                        await _force_close(symbol, lock, reason)
                        await alerts.alert_stop_loss(symbol, price, sl, direction, is_bybit=True)

        except Exception as exc:
            logger.error("bybit_exit_monitor error: %s", exc)

        await asyncio.sleep(EXIT_MONITOR_INTERVAL)


async def bybit_reconciliation_loop() -> None:
    """
    Every 5 minutes: cross-reference locks against live Bybit positions.
    Any lock without a live position is released (ghost-trade cleanup).
    """
    INTERVAL = 300
    await asyncio.sleep(60)
    while True:
        try:
            creds = get_bybit_creds()
            if creds:
                locks          = trade_tracker.all_locks()
                bybit_locked   = [s for s in locks if s.endswith("USDT")]
                live_positions = await fetch_positions(*creds)
                live_syms      = {p.get("symbol", "") for p in live_positions}
                for sym in bybit_locked:
                    if sym not in live_syms:
                        trade_tracker.unlock(sym)
                        logger.warning("🔓 Reconciliation: Bybit %s released (no live position)", sym)
        except Exception as exc:
            logger.debug("Bybit reconciliation error: %s", exc)
        await asyncio.sleep(INTERVAL)
