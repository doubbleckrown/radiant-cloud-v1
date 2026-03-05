"""fx-signal — Oanda REST routes"""
from __future__ import annotations
import time
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.core.auth import get_current_user
from app.core.config import INSTRUMENTS, GRANULARITIES, get_oanda_creds
from app.core.state import (
    candle_cache, latest_prices, oanda_daily_open,
    signal_history, oanda_engines,
)
from app.core.trade_tracker import trade_tracker
from app.core.config import TRADE_LOCK_TTL_SECONDS
from app.engines.oanda.executor import (
    fetch_account_summary, fetch_open_trades, fetch_trade_history,
    place_market_order, close_trade, compute_units,
)

router = APIRouter(prefix="/api", tags=["oanda"])


# ── Market data ───────────────────────────────────────────────────────────────

@router.get("/markets")
async def get_markets(_: dict = Depends(get_current_user)):
    result = []
    for ins in INSTRUMENTS:
        price      = latest_prices.get(ins, 0.0)
        daily_open = oanda_daily_open.get(ins, 0.0)
        h1         = candle_cache[ins]["H1"]
        state      = oanda_engines[ins].get_partial_state(h1, price) if len(h1) >= 210 else None
        change24h: float | None = None
        if price > 0 and daily_open > 0:
            change24h = round((price - daily_open) / daily_open * 100, 2)
        result.append({
            "instrument": ins,
            "price":      price,
            "change24h":  change24h,
            "confidence": state.confidence        if state else 0,
            "bias":       state.layer1_bias.value if state else "NEUTRAL",
        })
    return result


@router.get("/markets/{instrument}/candles")
async def get_candles(
    instrument:  str,
    granularity: str = "H1",
    count:       int = 120,
    _: dict = Depends(get_current_user),
):
    if instrument not in candle_cache:
        raise HTTPException(404, "Instrument not found")
    n       = max(1, min(count, 500))
    candles = candle_cache[instrument].get(granularity, [])
    return [{"t": c.time, "o": c.open, "h": c.high, "l": c.low, "c": c.close, "v": c.volume} for c in candles[-n:]]


@router.get("/markets/{instrument}/analysis")
async def get_analysis(instrument: str, _: dict = Depends(get_current_user)):
    if instrument not in oanda_engines:
        raise HTTPException(404, "Instrument not found")
    price = latest_prices.get(instrument, 0.0)
    h1    = candle_cache[instrument]["H1"]
    state = oanda_engines[instrument].get_partial_state(h1, price) if len(h1) >= 210 else None
    if not state:
        return {"confidence": 0}
    return {
        "instrument": instrument, "price": price, "confidence": state.confidence,
        "layer1": {"bias": state.layer1_bias.value, "active": state.layer1_bias.value != "NEUTRAL"},
        "layer2": {"active": state.layer2_active, "zone": str(state.layer2_zone) if state.layer2_zone else None},
        "layer3": {"mss": state.layer3_mss},
    }


@router.get("/signals")
async def get_signals(_: dict = Depends(get_current_user)):
    all_sigs = []
    for s in signal_history.values():
        all_sigs.extend(s)
    return sorted(all_sigs, key=lambda s: s["timestamp"], reverse=True)[:100]


# ── Account ───────────────────────────────────────────────────────────────────

@router.get("/account")
async def get_account(payload: dict = Depends(get_current_user)):
    creds = get_oanda_creds()
    if not creds:
        raise HTTPException(422, "No Oanda credentials — add OANDA_API_KEY/ACCOUNT_ID to .env")
    try:
        summary = await fetch_account_summary(*creds)
        # Oanda's openTradeCount = raw individual fills (e.g. 6 for 3 trades on 2 instruments).
        # Fetch the aggregated position list so the Summary tab shows the number of
        # open POSITIONS (instruments with exposure), matching the Open Trades tab card count.
        try:
            positions = await fetch_open_trades(*creds)
            summary["openTradeCount"] = len(positions)
        except Exception:
            pass  # fall back to Oanda's raw count on any error
        return summary
    except Exception as e:
        raise HTTPException(503, f"Oanda error: {e}")


@router.get("/account/trades")
async def get_open_trades(_: dict = Depends(get_current_user)):
    creds = get_oanda_creds()
    if not creds:
        raise HTTPException(422, "No Oanda credentials")
    try:
        return await fetch_open_trades(*creds)
    except Exception as e:
        raise HTTPException(503, f"Oanda error: {e}")


@router.get("/account/history")
async def get_trade_history(
    count:     int          = 500,
    before_id: str | None   = None,
    fetch_all: bool         = True,
    _:         dict         = Depends(get_current_user),
):
    """
    Return closed trade history.

    Query params
    ------------
    count     : Trades per page, max 500 (default 500).
    before_id : Cursor — return trades older than this trade ID.
                Use the id of the last trade in the current set to load
                the next page (Load More).
    fetch_all : If true (default), paginate automatically and return all
                trades up to 2,000 in a single response. Set false to get
                a single page.
    """
    creds = get_oanda_creds()
    if not creds:
        raise HTTPException(422, "No Oanda credentials")
    try:
        return await fetch_trade_history(
            *creds,
            count     = min(count, 500),
            before_id = before_id,
            fetch_all = fetch_all,
        )
    except Exception as e:
        raise HTTPException(503, f"Oanda error: {e}")


# ── Orders ────────────────────────────────────────────────────────────────────

class OrderRequest(BaseModel):
    instrument:  str
    units:       int
    stop_loss:   float
    take_profit: float


@router.post("/orders")
async def create_order(body: OrderRequest, _: dict = Depends(get_current_user)):
    creds = get_oanda_creds()
    if not creds:
        raise HTTPException(422, "No Oanda credentials")
    try:
        return await place_market_order(*creds, body.instrument, body.units, body.stop_loss, body.take_profit)
    except Exception as e:
        raise HTTPException(503, f"Order error: {e}")


class TradeCloseRequest(BaseModel):
    trade_id: Optional[str] = None
    symbol:   Optional[str] = None
    side:     Optional[str] = None
    qty:      Optional[str] = None
    broker:   str = "oanda"


@router.post("/trade/close")
async def close_trade_route(body: TradeCloseRequest, _: dict = Depends(get_current_user)):
    from app.core.config import get_bybit_creds
    from app.engines.bybit.executor import close_position, fetch_positions

    broker = (body.broker or "oanda").lower()

    if broker == "bybit":
        if not body.symbol or not body.side or not body.qty:
            raise HTTPException(422, "symbol, side, qty required for Bybit close")
        creds = get_bybit_creds()
        if not creds:
            raise HTTPException(503, "BYBIT credentials not in .env")
        try:
            result = await close_position(*creds, body.symbol, body.side, body.qty)
            trade_tracker.unlock(body.symbol)
            return {"ok": True, "broker": "bybit", "symbol": body.symbol, "result": result.get("result", {})}
        except Exception as exc:
            raise HTTPException(503, f"Bybit close failed: {exc}")
    else:
        if not body.trade_id:
            raise HTTPException(422, "trade_id required for Oanda close")
        creds = get_oanda_creds()
        if not creds:
            raise HTTPException(503, "Oanda credentials not in .env")
        try:
            result     = await close_trade(*creds, body.trade_id)
            fill_tx    = result.get("orderFillTransaction") or {}
            instrument = fill_tx.get("instrument", "")
            if instrument:
                trade_tracker.unlock(instrument)
            return {"ok": True, "broker": "oanda", "trade_id": body.trade_id, "instrument": instrument, "realized_pl": fill_tx.get("pl", "0")}
        except Exception as exc:
            raise HTTPException(503, f"Oanda close failed: {exc}")