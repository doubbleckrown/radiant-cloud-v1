"""
FX Radiant — Shared In-Memory Database
========================================
These module-level dictionaries act as the application's runtime
database. All routers and background tasks import from here so
they all read and write the SAME data.

In a production app you would replace these with Redis / PostgreSQL.
The interface (dict keys, value shapes) is kept simple so swapping
to a real DB later requires minimal changes in the routers.

Exported stores:
    users_db        {email: UserRecord}
    candle_cache    {instrument: {granularity: [Candle]}}
    latest_prices   {instrument: float}
    signal_history  {instrument: [signal_dict, ...]}   max 50 per instrument
    ws_clients      set of active WebSocket connections
"""

from __future__ import annotations

from app.core.config import settings
from app.services.strategy import SMCConfluenceEngine

# ── Users ─────────────────────────────────────────────────────────────────────
# Shape: { "trader@email.com": {"email": str, "name": str, "password": str} }
users_db: dict[str, dict] = {}

# ── Candle cache ──────────────────────────────────────────────────────────────
# Shape: { "EUR_USD": { "M5": [Candle, ...], "M15": [...], "H1": [...] } }
candle_cache: dict[str, dict[str, list]] = {
    ins: {gran: [] for gran in settings.GRANULARITIES}
    for ins in settings.INSTRUMENTS
}

# ── Latest mid-prices ─────────────────────────────────────────────────────────
# Shape: { "EUR_USD": 1.08342, ... }
latest_prices: dict[str, float] = {}

# ── Signal history ─────────────────────────────────────────────────────────────
# Shape: { "EUR_USD": [{"type":"SIGNAL", "direction":"LONG", ...}, ...] }
signal_history: dict[str, list[dict]] = {
    ins: [] for ins in settings.INSTRUMENTS
}

# ── WebSocket client pool ─────────────────────────────────────────────────────
# A plain set of active WebSocket objects. The WS manager broadcasts to all.
ws_clients: set = set()

# ── SMC Confluence Engines (one per instrument) ───────────────────────────────
# These are long-lived objects that hold per-instrument state.
smc_engines: dict[str, SMCConfluenceEngine] = {
    ins: SMCConfluenceEngine(
        instrument=ins,
        ema_period=settings.EMA_PERIOD,
        hysteresis=settings.EMA_HYSTERESIS_PCT,
        swing_lb=settings.SWING_LOOKBACK,
        rr_ratio=settings.DEFAULT_RR_RATIO,
    )
    for ins in settings.INSTRUMENTS
}