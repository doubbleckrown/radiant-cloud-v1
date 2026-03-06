"""
app/core/trade_tracker.py — Shared TradeTracker (one instance, both engines).
"""
from __future__ import annotations
import logging
import time
from app.core.config import TRADE_LOCK_TTL_SECONDS

logger = logging.getLogger("fx-signal")


class TradeTracker:
    """
    In-memory trade-lock registry. Prevents duplicate signal execution.
    Each lock stores: direction, entry, sl, tp, trade_id, opened_at, expires_at.
    opened_at is preserved across pending→filled updates so TTL starts at signal time.
    """

    def __init__(self) -> None:
        self._locks: dict[str, dict] = {}

    def is_locked(self, symbol: str) -> bool:
        lock = self._locks.get(symbol)
        if not lock:
            return False
        if time.time() > lock["expires_at"]:
            del self._locks[symbol]
            logger.info("TradeTracker: TTL-expired lock released for %s", symbol)
            return False
        return True

    def lock(
        self,
        symbol:    str,
        direction: str,
        entry:     float,
        trade_id:  str   = "",
        sl:        float = 0.0,
        tp:        float = 0.0,
    ) -> None:
        now      = time.time()
        existing = self._locks.get(symbol, {})
        opened   = existing.get("opened_at", now)
        self._locks[symbol] = {
            "direction":  direction,
            "entry":      entry,
            "sl":         sl   if sl   != 0.0 else existing.get("sl",   0.0),
            "tp":         tp   if tp   != 0.0 else existing.get("tp",   0.0),
            "trade_id":   trade_id,
            "opened_at":  opened,
            "expires_at": opened + TRADE_LOCK_TTL_SECONDS,
        }
        logger.info(
            "TradeTracker: LOCKED %s %s @ %.5f  sl=%.5f  tp=%.5f",
            symbol, direction, entry,
            self._locks[symbol]["sl"], self._locks[symbol]["tp"],
        )

    def unlock(self, symbol: str) -> None:
        if symbol in self._locks:
            del self._locks[symbol]
            logger.info("TradeTracker: UNLOCKED %s", symbol)

    def get_lock(self, symbol: str) -> dict | None:
        return self._locks.get(symbol) if self.is_locked(symbol) else None

    def all_locks(self) -> dict[str, dict]:
        """
        Return ALL active locks — including TTL-expired ones.

        Do NOT prune expired locks here.  The exit_monitor_loop in watcher.py
        must see expired locks so it can call the broker close API before
        unlocking.  Pruning them here means the watcher never fires the close
        call, leaving real open positions on the exchange with no exit order.

        Stale locks that were never traded (e.g. pending orders that timed out
        without a fill) are cleaned up by is_locked() on the next signal check.
        """
        return dict(self._locks)


# Global singleton — imported by both engine executors and exit watcher
trade_tracker = TradeTracker()