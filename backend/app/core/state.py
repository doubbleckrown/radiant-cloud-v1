"""
app/core/state.py — Shared in-memory state accessed by both engines.
All dicts are module-level singletons imported by reference.
"""
from __future__ import annotations
from fastapi import WebSocket
from app.core.config import INSTRUMENTS, GRANULARITIES, BYBIT_SYMBOLS, BYBIT_INTERVALS
from app.services.strategy import Candle, SMCConfluenceEngine

# ── Oanda ─────────────────────────────────────────────────────────────────────
candle_cache:   dict[str, dict[str, list[Candle]]] = {
    ins: {gran: [] for gran in GRANULARITIES} for ins in INSTRUMENTS
}
latest_prices:  dict[str, float] = {}
oanda_daily_open: dict[str, float] = {}
ws_clients:     set[WebSocket] = set()
signal_history: dict[str, list[dict]] = {ins: [] for ins in INSTRUMENTS}
oanda_engines:  dict[str, SMCConfluenceEngine] = {
    ins: SMCConfluenceEngine(ins, ema_period=200, rr_ratio=3.0)
    for ins in INSTRUMENTS
}

# ── Bybit ─────────────────────────────────────────────────────────────────────
bybit_candle_cache: dict[str, dict[str, list[Candle]]] = {
    sym: {iv: [] for iv in BYBIT_INTERVALS} for sym in BYBIT_SYMBOLS
}
bybit_prices:     dict[str, float] = {}
bybit_meta:       dict[str, dict]  = {}
bybit_signal_history: dict[str, list[dict]] = {sym: [] for sym in BYBIT_SYMBOLS}
bybit_engines:    dict[str, SMCConfluenceEngine] = {
    sym: SMCConfluenceEngine(sym, ema_period=50, rr_ratio=3.0)
    for sym in BYBIT_SYMBOLS
}

# ── Push ──────────────────────────────────────────────────────────────────────
push_subscriptions: set[str] = set()
