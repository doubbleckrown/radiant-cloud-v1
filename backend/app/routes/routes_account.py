"""app/routes/routes_account.py — Oanda + Bybit account, trade, close endpoints."""
from __future__ import annotations
import logging
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from app.core.auth import get_current_user
from app.core.config import get_oanda_creds, get_bybit_creds
from app.core.trade_tracker import trade_tracker

logger = logging.getLogger("fx-signal")
router = APIRouter()


# ─────────────────────────────────────────────────────────────────────────────
#  Oanda
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/api/account")
async def oanda_account(payload: dict = Depends(get_current_user)):
    creds = get_oanda_creds()
    if not creds:
        raise HTTPException(422, "OANDA_API_KEY/ACCOUNT_ID not configured")
    from app.engines.oanda.executor import fetch_account_summary
    try:
        return await fetch_account_summary(*creds)
    except Exception as e:
        raise HTTPException(503, f"Oanda error: {e}")


@router.get("/api/account/trades")
async def oanda_open_trades(payload: dict = Depends(get_current_user)):
    creds = get_oanda_creds()
    if not creds:
        raise HTTPException(422, "OANDA_API_KEY/ACCOUNT_ID not configured")
    from app.engines.oanda.executor import fetch_open_trades
    try:
        return await fetch_open_trades(*creds)
    except Exception as e:
        logger.error("/api/account/trades failed: %s", e, exc_info=True)
        raise HTTPException(503, f"Oanda error: {e}")


@router.get("/api/account/history")
async def oanda_trade_history(
    payload:   dict = Depends(get_current_user),
    count:     int  = 500,
    fetch_all: bool = True,
    before_id: Optional[str] = None,
):
    creds = get_oanda_creds()
    if not creds:
        raise HTTPException(422, "OANDA_API_KEY/ACCOUNT_ID not configured")
    from app.engines.oanda.executor import fetch_trade_history
    try:
        return await fetch_trade_history(
            *creds,
            count     = min(count, 500),
            fetch_all = fetch_all,
            before_id = before_id,
        )
    except Exception as e:
        raise HTTPException(503, f"Oanda error: {e}")


# ─────────────────────────────────────────────────────────────────────────────
#  Bybit
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/api/bybit/account")
async def bybit_account(payload: dict = Depends(get_current_user)):
    creds = get_bybit_creds()
    if not creds:
        raise HTTPException(422, "BYBIT_API_KEY/SECRET not configured")
    from app.engines.bybit.executor import fetch_account
    try:
        return await fetch_account(*creds)
    except RuntimeError as e:
        raise HTTPException(503, f"Bybit API error: {e}")
    except Exception as e:
        raise HTTPException(503, f"Bybit API error: {e}")


@router.get("/api/bybit/account/positions")
async def bybit_positions(payload: dict = Depends(get_current_user)):
    creds = get_bybit_creds()
    if not creds:
        raise HTTPException(422, "BYBIT_API_KEY/SECRET not configured")
    from app.engines.bybit.executor import fetch_positions
    try:
        return await fetch_positions(*creds)
    except RuntimeError as e:
        raise HTTPException(503, f"Bybit API error: {e}")
    except Exception as e:
        raise HTTPException(503, f"Bybit API error: {e}")


@router.get("/api/bybit/account/history")
async def bybit_trade_history(payload: dict = Depends(get_current_user), limit: int = 50):
    creds = get_bybit_creds()
    if not creds:
        raise HTTPException(422, "BYBIT_API_KEY/SECRET not configured")
    from app.engines.bybit.executor import fetch_trade_history
    try:
        return await fetch_trade_history(*creds, limit=min(limit, 100))
    except RuntimeError as e:
        raise HTTPException(503, f"Bybit API error: {e}")
    except Exception as e:
        raise HTTPException(503, f"Bybit API error: {e}")


# ─────────────────────────────────────────────────────────────────────────────
#  Manual close
# ─────────────────────────────────────────────────────────────────────────────

class TradeCloseRequest(BaseModel):
    trade_id: Optional[str] = None
    symbol:   Optional[str] = None
    side:     Optional[str] = None
    qty:      Optional[str] = None
    broker:   str = "oanda"


@router.post("/api/trade/close")
async def close_trade(body: TradeCloseRequest, _: dict = Depends(get_current_user)):
    broker = (body.broker or "oanda").lower()

    if broker == "bybit":
        if not (body.symbol and body.side and body.qty):
            raise HTTPException(422, "symbol, side, qty required for Bybit close")
        creds = get_bybit_creds()
        if not creds:
            raise HTTPException(503, "BYBIT_API_KEY/SECRET not configured")
        from app.engines.bybit.executor import close_position
        try:
            result = await close_position(*creds, body.symbol, body.side, body.qty)
            trade_tracker.unlock(body.symbol)
            return {"ok": True, "broker": "bybit", "symbol": body.symbol,
                    "result": result.get("result", {})}
        except Exception as exc:
            raise HTTPException(503, f"Bybit close failed: {exc}")
    else:
        if not body.trade_id:
            raise HTTPException(422, "trade_id required for Oanda close")
        creds = get_oanda_creds()
        if not creds:
            raise HTTPException(503, "OANDA_API_KEY/ACCOUNT_ID not configured")
        from app.engines.oanda.executor import close_trade as oanda_close
        try:
            result     = await oanda_close(*creds, body.trade_id)
            fill_tx    = result.get("orderFillTransaction") or {}
            instrument = fill_tx.get("instrument", "")
            if instrument:
                trade_tracker.unlock(instrument)
            return {"ok": True, "broker": "oanda", "trade_id": body.trade_id,
                    "instrument": instrument, "realized_pl": fill_tx.get("pl", "0")}
        except Exception as exc:
            raise HTTPException(503, f"Oanda close failed: {exc}")