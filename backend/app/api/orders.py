"""
FX Radiant — Orders & Account Router
======================================
All account management and trading endpoints:

    GET    /api/account                        → Account summary (balance, NAV, P&L)
    GET    /api/account/positions              → All open positions
    POST   /api/orders                         → Place a new market order
    DELETE /api/positions/{instrument}         → Close a position

These routes talk directly to the Oanda v20 REST API.
If Oanda is unreachable (e.g. outside market hours), they raise HTTP 503.
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path, status

from app.core.config import settings
from app.core.security import get_current_user
from app.models.order import ClosePositionRequest, OpenPosition, OrderRequest

router = APIRouter(tags=["Account & Orders"])

# ── Oanda HTTP client helper ──────────────────────────────────────────────────

def _oanda_headers() -> dict:
    return {
        "Authorization": f"Bearer {settings.OANDA_API_KEY}",
        "Content-Type":  "application/json",
    }


async def _oanda_get(path: str) -> dict:
    """GET a resource from the Oanda REST API."""
    url = f"{settings.OANDA_BASE_URL}{path}"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, headers=_oanda_headers())
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Oanda API error: {e.response.status_code} — {e.response.text}",
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Could not reach Oanda: {str(e)}",
        )


async def _oanda_post(path: str, body: dict) -> dict:
    """POST to the Oanda REST API."""
    url = f"{settings.OANDA_BASE_URL}{path}"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(url, headers=_oanda_headers(), json=body)
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Oanda API error: {e.response.status_code} — {e.response.text}",
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Could not reach Oanda: {str(e)}",
        )


# ── Account summary ───────────────────────────────────────────────────────────

@router.get(
    "/account",
    summary="Get live account summary from Oanda",
)
async def get_account(
    _: dict = Depends(get_current_user),
) -> dict:
    """
    Returns the full Oanda account summary including:
      balance, NAV, unrealised P&L, margin used/available,
      open trade count, open position count.
    """
    data = await _oanda_get(f"/v3/accounts/{settings.OANDA_ACCOUNT_ID}/summary")
    return data.get("account", data)


# ── Open positions ────────────────────────────────────────────────────────────

@router.get(
    "/account/positions",
    summary="Get all currently open positions",
)
async def get_positions(
    _: dict = Depends(get_current_user),
) -> list[dict]:
    """
    Returns all open positions on the account.
    An empty list means no trades are currently open.
    """
    data = await _oanda_get(f"/v3/accounts/{settings.OANDA_ACCOUNT_ID}/openPositions")
    return data.get("positions", [])


# ── Place market order ────────────────────────────────────────────────────────

@router.post(
    "/orders",
    summary="Place a market order with SL and TP",
    status_code=status.HTTP_201_CREATED,
)
async def create_order(
    body: OrderRequest,
    _: dict = Depends(get_current_user),
) -> dict:
    """
    Places a market order on Oanda with dynamic Stop Loss and Take Profit.

    The SL and TP price levels are calculated by the SMC Risk Engine and
    passed in by the frontend when the user taps 'Execute Signal'.

    units:
      Positive number  = LONG  (buy)
      Negative number  = SHORT (sell)

    Example request body:
      {
        "instrument":  "EUR_USD",
        "units":       10000,
        "stop_loss":   1.07840,
        "take_profit": 1.09200
      }
    """
    order_payload = {
        "order": {
            "type":        "MARKET",
            "instrument":  body.instrument,
            "units":       str(body.units),
            "timeInForce": "FOK",
            "stopLossOnFill": {
                "price": f"{body.stop_loss:.5f}",
                "timeInForce": "GTC",
            },
            "takeProfitOnFill": {
                "price": f"{body.take_profit:.5f}",
                "timeInForce": "GTC",
            },
        }
    }

    result = await _oanda_post(
        f"/v3/accounts/{settings.OANDA_ACCOUNT_ID}/orders",
        order_payload,
    )
    return result


# ── Close position ────────────────────────────────────────────────────────────

@router.delete(
    "/positions/{instrument}",
    summary="Close an open position for an instrument",
)
async def close_position(
    instrument: str = Path(description="e.g. EUR_USD"),
    body: ClosePositionRequest = None,
    _: dict = Depends(get_current_user),
) -> dict:
    """
    Closes all or part of an open position.
    By default closes the entire position ("ALL" units).

    To close only part of a position, pass longUnits or shortUnits as
    a number string e.g. "5000".
    """
    if body is None:
        body = ClosePositionRequest()

    close_payload = {
        "longUnits":  body.long_units,
        "shortUnits": body.short_units,
    }

    result = await _oanda_post(
        f"/v3/accounts/{settings.OANDA_ACCOUNT_ID}/positions/{instrument}/close",
        close_payload,
    )
    return result