"""
fx-signal — FastAPI entry point  v4.0
Dual-engine architecture: Oanda + Bybit fully isolated.
All settings Clerk-linked via user_vault.
"""
from __future__ import annotations
import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# Core
from app.core.auth import fetch_clerk_jwks, get_current_user, verify_clerk_token
from app.core.config import INSTRUMENTS, BYBIT_SYMBOLS, get_oanda_creds, get_bybit_creds
from app.core.trade_tracker import trade_tracker
import app.core.state as state

# Engines
from app.engines.oanda.engine import price_stream_loop, candle_refresh_loop
from app.engines.bybit.engine import bybit_refresh_loop, fetch_tickers
from app.engines.oanda.executor import fetch_candles, fetch_account_summary
from app.engines.bybit.engine import fetch_candles as bybit_fetch_candles
from app.engines.watcher import exit_monitor_loop

# Routes
from app.routes.routes_markets  import router as markets_router
from app.routes.routes_signals  import router as signals_router
from app.routes.routes_account  import router as account_router
from app.routes.routes_profile  import router as profile_router

logger = logging.getLogger("fx-signal")
logging.basicConfig(level=logging.INFO)


# ─────────────────────────────────────────────────────────────────────────────
#  Reconciliation loop
# ─────────────────────────────────────────────────────────────────────────────

async def trade_reconciliation_loop() -> None:
    """Every 5 min: release ghost locks whose live position is gone."""
    await asyncio.sleep(60)
    while True:
        try:
            locks = trade_tracker.all_locks()
            if locks:
                oanda_creds = get_oanda_creds()
                if oanda_creds:
                    try:
                        from app.engines.oanda.executor import fetch_open_trades
                        live = {t.get("instrument") for t in await fetch_open_trades(*oanda_creds)}
                        for ins in [s for s in locks if "_" in s and not s.endswith("USDT")]:
                            if ins not in live:
                                trade_tracker.unlock(ins)
                                logger.warning("🔓 Reconcile: Oanda ghost lock released for %s", ins)
                    except Exception as e:
                        logger.debug("Reconcile Oanda: %s", e)

                bybit_creds = get_bybit_creds()
                if bybit_creds:
                    try:
                        from app.engines.bybit.executor import fetch_positions
                        live = {p.get("symbol") for p in await fetch_positions(*bybit_creds)}
                        for sym in [s for s in locks if s.endswith("USDT")]:
                            if sym not in live:
                                trade_tracker.unlock(sym)
                                logger.warning("🔓 Reconcile: Bybit ghost lock released for %s", sym)
                    except Exception as e:
                        logger.debug("Reconcile Bybit: %s", e)
        except Exception as e:
            logger.error("trade_reconciliation_loop: %s", e)
        await asyncio.sleep(300)


# ─────────────────────────────────────────────────────────────────────────────
#  Lifespan — startup / shutdown
# ─────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("━" * 60)
    logger.info("  fx-signal v4.0  🤖  Dual-Engine — Oanda + Bybit")
    logger.info("  Oanda: %d instruments  |  Bybit: %d symbols", len(INSTRUMENTS), len(BYBIT_SYMBOLS))
    await fetch_clerk_jwks()

    for label, val in [
        ("OANDA_API_KEY",    os.environ.get("OANDA_API_KEY",    "")),
        ("OANDA_ACCOUNT_ID", os.environ.get("OANDA_ACCOUNT_ID", "")),
        ("BYBIT_API_KEY",    os.environ.get("BYBIT_API_KEY",    "")),
        ("BYBIT_API_SECRET", os.environ.get("BYBIT_API_SECRET", "")),
    ]:
        logger.info("  %-20s: %s", label, "✅ set" if val.strip() else "❌ MISSING")

    # ── Oanda startup probe ───────────────────────────────────────────────────
    oanda_creds = get_oanda_creds()
    if oanda_creds:
        try:
            acct = await asyncio.wait_for(fetch_account_summary(*oanda_creds), timeout=10.0)
            logger.info("Oanda NAV=%.2f  balance=%.2f  openTrades=%s",
                        float(acct.get("NAV", 0)), float(acct.get("balance", 0)),
                        acct.get("openTradeCount", "?"))
        except Exception as exc:
            logger.warning("Oanda startup probe: %s", exc)

    # ── Seed Oanda candles ────────────────────────────────────────────────────
    from app.core.config import GRANULARITIES
    async def _seed_oanda(ins, gran):
        try:
            return ins, gran, await asyncio.wait_for(fetch_candles(ins, gran), timeout=20.0)
        except Exception as exc:
            logger.warning("Oanda seed %s %s: %s", ins, gran, exc)
        return ins, gran, None

    results = await asyncio.gather(*[_seed_oanda(i, g) for i in INSTRUMENTS for g in GRANULARITIES])
    seeded = sum(1 for _, _, c in results if c is not None)
    for ins, gran, candles in results:
        if candles is not None:
            state.candle_cache[ins][gran] = candles
    logger.info("Oanda candle seed: %d/%d loaded", seeded, len(results))

    # ── Seed Bybit ────────────────────────────────────────────────────────────
    try:
        td = await asyncio.wait_for(fetch_tickers(BYBIT_SYMBOLS), timeout=12.0)
        for sym, meta in td.items():
            state.bybit_prices[sym] = meta["price"]
            state.bybit_meta[sym]   = meta
        logger.info("Bybit tickers: %d symbols loaded", len(td))
    except Exception as exc:
        logger.warning("Bybit ticker seed: %s", exc)

    async def _seed_bybit(sym, iv):
        try:
            return sym, iv, await asyncio.wait_for(bybit_fetch_candles(sym, iv), timeout=15.0)
        except Exception as exc:
            logger.warning("Bybit seed %s %s: %s", sym, iv, exc)
        return sym, iv, None

    bybit_results = await asyncio.gather(*[_seed_bybit(s, iv) for s in BYBIT_SYMBOLS for iv in ("240", "60", "15")])
    bseeded = sum(1 for _, _, c in bybit_results if c is not None)
    for sym, iv, candles in bybit_results:
        if candles is not None:
            state.bybit_candle_cache[sym][iv] = candles
    logger.info("Bybit candle seed: %d/%d loaded (4H+H1+M15)", bseeded, len(bybit_results))

    # ── Start background loops ────────────────────────────────────────────────
    asyncio.create_task(price_stream_loop())
    asyncio.create_task(candle_refresh_loop())
    asyncio.create_task(bybit_refresh_loop())
    asyncio.create_task(exit_monitor_loop())
    asyncio.create_task(trade_reconciliation_loop())
    logger.info("━" * 60)
    yield


# ─────────────────────────────────────────────────────────────────────────────
#  App
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(title="fx-signal API", version="4.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=False,
    allow_methods=["*"], allow_headers=["*"],
)


@app.exception_handler(Exception)
async def _global_exc(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled %s %s", request.method, request.url)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"},
                        headers={"Access-Control-Allow-Origin": "*"})


# ── Include route modules ─────────────────────────────────────────────────────
app.include_router(markets_router)
app.include_router(signals_router)
app.include_router(account_router)
app.include_router(profile_router)


# ─────────────────────────────────────────────────────────────────────────────
#  Push registration
# ─────────────────────────────────────────────────────────────────────────────

class PushRegisterRequest(BaseModel):
    player_id: str


@app.post("/api/push/register")
async def register_push(body: PushRegisterRequest, _: dict = Depends(get_current_user)):
    pid = body.player_id.strip()
    if not pid:
        raise HTTPException(400, "player_id required")
    state.push_subscriptions.add(pid)
    logger.info("📲 Push registered: %s… (%d total)", pid[:8], len(state.push_subscriptions))
    return {"registered": True, "total_subscribers": len(state.push_subscriptions)}


# ─────────────────────────────────────────────────────────────────────────────
#  WebSocket
# ─────────────────────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, token: str = ""):
    try:
        await verify_clerk_token(token)
    except HTTPException:
        await ws.close(code=4001)
        return
    await ws.accept()
    state.ws_clients.add(ws)
    logger.info("WS connected. Total: %d", len(state.ws_clients))
    await ws.send_text(json.dumps({
        "type": "SNAPSHOT",
        "prices": state.latest_prices,
        "signals": {ins: state.signal_history[ins][:5] for ins in INSTRUMENTS},
    }))
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue
            if msg.get("type") == "SUBSCRIBE":
                ins = msg.get("instrument", "")
                if ins in INSTRUMENTS:
                    p = state.latest_prices.get(ins)
                    if p:
                        await ws.send_text(json.dumps({
                            "type": "TICK", "instrument": ins,
                            "bid": p, "ask": p, "mid": p, "time": str(int(time.time())),
                        }))
    except WebSocketDisconnect:
        state.ws_clients.discard(ws)
        logger.info("WS disconnected. Total: %d", len(state.ws_clients))


# ─────────────────────────────────────────────────────────────────────────────
#  Health
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok", "version": "4.0.0",
        "oanda_prices_cached":  len(state.latest_prices),
        "bybit_prices_cached":  sum(1 for p in state.bybit_prices.values() if p > 0),
        "trade_locks":          len(trade_tracker.all_locks()),
        "oanda_executor":       "READY" if get_oanda_creds() else "NO_CREDS",
        "bybit_executor":       "READY" if get_bybit_creds() else "NO_CREDS",
        "exit_monitor":         "active (30s sweep)",
        "timestamp":            int(time.time()),
    }