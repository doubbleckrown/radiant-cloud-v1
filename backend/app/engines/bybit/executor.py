"""
app/engines/bybit/executor.py
==============================
Bybit V5 Linear signing, order placement, and auto-execution.

CRITICAL FIX — Error 10004 / 1004 (Invalid Signature):
  POST signature string = timestamp + apiKey + recvWindow + body_string
  body_string MUST be:  json.dumps(payload, separators=(',', ':'))
  — compact JSON with NO whitespace. Any space → signature mismatch.

The string order is:  ts + api_key + recv_window + payload_string
recv_window is fixed at "5000" (string, not int).
"""
from __future__ import annotations
import hashlib
import hmac
import json
import logging
import time
import urllib.parse
from typing import Any

import httpx

from app.core.config import (
    BYBIT_BASE, BYBIT_RECV_WINDOW,
    BYBIT_DEFAULT_LEVERAGE, BYBIT_MARGIN_TYPE,
    BYBIT_MIN_ORDER_QTY, get_bybit_creds,
)
from app.core.trade_tracker import trade_tracker
from app.services.strategy import TradeSignal

logger = logging.getLogger("fx-signal")


# ─────────────────────────────────────────────────────────────────────────────
#  Signing primitives
# ─────────────────────────────────────────────────────────────────────────────

def _ts() -> str:
    return str(int(time.time() * 1000))


def _sign(secret: str, payload: str) -> str:
    return hmac.new(
        secret.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _auth_headers(api_key: str, sig: str, ts: str) -> dict:
    return {
        "X-BAPI-API-KEY":     api_key,
        "X-BAPI-SIGN":        sig,
        "X-BAPI-TIMESTAMP":   ts,
        "X-BAPI-RECV-WINDOW": BYBIT_RECV_WINDOW,
        "X-BAPI-SIGN-TYPE":   "2",
        "Content-Type":       "application/json",
    }


def sign_get(api_key: str, api_secret: str, params: dict) -> tuple[dict, dict]:
    """
    Sign a GET request.
    String: ts + apiKey + recvWindow + queryString (sorted params, url-encoded once).
    """
    ts  = _ts()
    qs  = urllib.parse.urlencode(sorted(params.items()))
    sig = _sign(api_secret, ts + api_key + BYBIT_RECV_WINDOW + qs)
    return params, _auth_headers(api_key, sig, ts)


def sign_post(api_key: str, api_secret: str, body: dict) -> tuple[dict, dict]:
    """
    Sign a POST request.
    String: ts + apiKey + recvWindow + json_body (COMPACT — no whitespace).

    Uses separators=(',', ':') to strip all spaces. This is the root cause
    of error 10004 when standard json.dumps (which adds spaces) is used.
    """
    ts         = _ts()
    body_str   = json.dumps(body, separators=(",", ":"), ensure_ascii=True)
    sig        = _sign(api_secret, ts + api_key + BYBIT_RECV_WINDOW + body_str)
    return body, _auth_headers(api_key, sig, ts)


def raise_on_error(data: dict, ctx: str = "") -> None:
    ret = data.get("retCode", -1)
    if ret == 0:
        return
    msg  = data.get("retMsg", "Unknown error")
    hint = {
        10003: " — API key not found; check BYBIT_API_KEY",
        10004: " — Invalid signature; check clock sync (NTP) and key permissions",
        10005: " — API key expired; regenerate in Bybit dashboard",
        10006: " — Rate limit; reduce request frequency",
    }.get(ret, "")
    raise RuntimeError(f"Bybit retCode {ret}: {msg}{hint} [{ctx}]")


# ─────────────────────────────────────────────────────────────────────────────
#  Account & position helpers
# ─────────────────────────────────────────────────────────────────────────────

async def fetch_account(api_key: str, api_secret: str) -> dict:
    params, headers = sign_get(api_key, api_secret, {"accountType": "UNIFIED"})
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0)) as c:
            r = await c.get(f"{BYBIT_BASE}/v5/account/wallet-balance",
                            headers=headers, params=params)
            r.raise_for_status()
    except httpx.TimeoutException as e:
        raise RuntimeError(f"Bybit account timeout: {e}") from e
    except httpx.HTTPStatusError as e:
        raise RuntimeError(f"Bybit HTTP {e.response.status_code} on account: {e.response.text[:200]}") from e

    data = r.json()
    raise_on_error(data, "fetch_account")
    acct = (data.get("result", {}).get("list") or [{}])[0]
    eq   = float(acct.get("totalEquity",           0) or 0)
    av   = float(acct.get("totalAvailableBalance", 0) or 0)
    mg   = float(acct.get("totalMarginBalance",    0) or 0)
    return {
        "accountType":           acct.get("accountType", "UNIFIED"),
        "totalEquity":           round(eq, 2),
        "totalMarginBalance":    round(mg, 2),
        "totalAvailableBalance": round(av, 2),
        "totalAvailable":        round(av, 2),
        "totalMargin":           round(mg, 2),
        "totalUSDT":             round(eq, 2),
        "coin": [c for c in acct.get("coin", []) if float(c.get("walletBalance", 0) or 0) > 0],
    }


async def fetch_positions(api_key: str, api_secret: str) -> list:
    try:
        params, headers = sign_get(api_key, api_secret, {
            "category": "linear", "settleCoin": "USDT", "limit": "50",
        })
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0)) as c:
            r = await c.get(f"{BYBIT_BASE}/v5/position/list",
                            headers=headers, params=params)
            r.raise_for_status()
        data = r.json()
        raise_on_error(data, "fetch_positions")
        return [p for p in data.get("result", {}).get("list", [])
                if float(p.get("size", 0) or 0) > 0]
    except httpx.TimeoutException as e:
        logger.warning("fetch_positions timeout — returning []: %s", e)
        return []
    except httpx.HTTPStatusError as e:
        raise RuntimeError(f"Bybit HTTP {e.response.status_code} on positions: {e.response.text[:200]}") from e


async def fetch_trade_history(api_key: str, api_secret: str, limit: int = 50) -> list:
    params, headers = sign_get(api_key, api_secret, {
        "category": "linear", "limit": str(min(limit, 100)),
    })
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.get(f"{BYBIT_BASE}/v5/execution/list", headers=headers, params=params)
        r.raise_for_status()
    data = r.json()
    raise_on_error(data, "fetch_trade_history")
    trades = data.get("result", {}).get("list", [])
    trades.sort(key=lambda t: int(t.get("execTime", 0)), reverse=True)
    return trades


# ─────────────────────────────────────────────────────────────────────────────
#  Order placement helpers
# ─────────────────────────────────────────────────────────────────────────────

async def _set_margin_mode(api_key: str, secret: str, symbol: str,
                           margin_type: str = "ISOLATED") -> None:
    body = {
        "category": "linear", "symbol": symbol,
        "tradeMode": 1 if margin_type == "ISOLATED" else 0,
        "buyLeverage":  str(BYBIT_DEFAULT_LEVERAGE),
        "sellLeverage": str(BYBIT_DEFAULT_LEVERAGE),
    }
    _, headers = sign_post(api_key, secret, body)
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(f"{BYBIT_BASE}/v5/position/switch-isolated",
                             headers=headers, json=body)
        d = r.json()
        if d.get("retCode", -1) not in (0, 110043):
            logger.warning("set_margin_mode %s: %s %s", symbol, d.get("retCode"), d.get("retMsg"))
    except Exception as e:
        logger.warning("set_margin_mode %s: %s", symbol, e)


async def _set_leverage(api_key: str, secret: str, symbol: str,
                        leverage: int, margin_type: str = "ISOLATED") -> None:
    await _set_margin_mode(api_key, secret, symbol, margin_type)
    body = {
        "category": "linear", "symbol": symbol,
        "buyLeverage": str(leverage), "sellLeverage": str(leverage),
    }
    _, headers = sign_post(api_key, secret, body)
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(f"{BYBIT_BASE}/v5/position/set-leverage",
                         headers=headers, json=body)
    d = r.json()
    if d.get("retCode", -1) not in (0, 110043):
        logger.warning("set_leverage %s: %s %s", symbol, d.get("retCode"), d.get("retMsg"))


async def place_market_order(
    api_key: str, secret: str, symbol: str,
    side: str, qty: str,
    stop_loss: float, take_profit: float,
    leverage: int  = BYBIT_DEFAULT_LEVERAGE,
    margin_type: str = "ISOLATED",
) -> dict:
    """
    Place a Bybit Linear perpetual market order with SL + TP attached.
    Sets margin mode + leverage first (pre-flight).
    """
    await _set_leverage(api_key, secret, symbol, leverage, margin_type)

    body = {
        "category":    "linear",
        "symbol":      symbol,
        "side":        side,
        "orderType":   "Market",
        "qty":         qty,
        "stopLoss":    f"{stop_loss:.4f}",
        "takeProfit":  f"{take_profit:.4f}",
        "tpTriggerBy": "MarkPrice",
        "slTriggerBy": "MarkPrice",
        "timeInForce": "IOC",
        "positionIdx": 0,
    }
    _, headers = sign_post(api_key, secret, body)
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(f"{BYBIT_BASE}/v5/order/create", headers=headers, json=body)
        r.raise_for_status()
    data = r.json()
    raise_on_error(data, f"place_market_order {symbol}")
    logger.info("✅ Bybit order: %s %s Market  qty=%s", symbol, side, qty)
    return data


async def close_position(api_key: str, secret: str,
                         symbol: str, side: str, qty: str) -> dict:
    """Reduce-only market close. side=current position side (we flip it)."""
    close_side = "Sell" if side == "Buy" else "Buy"
    body = {
        "category": "linear", "symbol": symbol,
        "side": close_side, "orderType": "Market",
        "qty": qty, "timeInForce": "IOC",
        "positionIdx": 0, "reduceOnly": True,
    }
    _, headers = sign_post(api_key, secret, body)
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(f"{BYBIT_BASE}/v5/order/create", headers=headers, json=body)
        r.raise_for_status()
    data = r.json()
    raise_on_error(data, f"close_position {symbol}")
    logger.info("✅ Bybit position closed: %s %s qty=%s", symbol, close_side, qty)
    return data


# ─────────────────────────────────────────────────────────────────────────────
#  Auto-execution at 100% confluence
# ─────────────────────────────────────────────────────────────────────────────

def _safe_leverage(entry: float, sl: float, leverage: int) -> int:
    sl_dist = abs(entry - sl)
    if sl_dist <= 0 or entry <= 0:
        return leverage
    ratio = (sl_dist / entry) * leverage
    while ratio > 0.8 and leverage > 1:
        leverage -= 1
        ratio = (sl_dist / entry) * leverage
    return leverage


async def auto_execute(sym: str, sig_dict: dict, signal: TradeSignal) -> None:
    """
    Hard-automate Bybit order at 100% confluence.
    On failure: stamps sig_dict with exec_status='failed' + exec_error so
    SignalsPage.jsx moves the card to the History tab immediately.
    """
    from app.database.user_vault import get_risk_pct

    if trade_tracker.is_locked(sym):
        logger.info("Bybit AutoExec: %s locked — skip", sym)
        return

    creds = get_bybit_creds()
    if not creds:
        sig_dict["exec_status"] = "failed"
        sig_dict["exec_error"]  = "BYBIT_API_KEY/SECRET not configured in .env"
        return

    api_key, secret = creds
    try:
        acct_data = await fetch_account(api_key, secret)
        equity    = float(acct_data.get("totalEquity", 0) or 0)
        if equity <= 0:
            sig_dict["exec_status"] = "failed"
            sig_dict["exec_error"]  = "Zero account equity"
            return

        clerk_id = sig_dict.get("clerk_id", "")
        risk_pct = get_risk_pct(clerk_id, "bybit") if clerk_id else 0.10
        risk_usd = max(equity * risk_pct, 1.20)   # floor $1.20 initial margin

        entry   = signal.entry_price
        sl      = signal.stop_loss
        tp      = signal.take_profit
        sl_dist = abs(entry - sl)
        if sl_dist == 0:
            sig_dict["exec_status"] = "failed"
            sig_dict["exec_error"]  = "SL equals entry"
            return

        lev      = _safe_leverage(entry, sl, BYBIT_DEFAULT_LEVERAGE)
        qty_raw  = (risk_usd * lev) / (sl_dist * entry)
        min_qty  = BYBIT_MIN_ORDER_QTY.get(sym, 0.001)
        qty      = max(round(qty_raw, 3), min_qty)
        side     = "Buy" if signal.direction.value == "LONG" else "Sell"

        trade_tracker.lock(sym, signal.direction.value, entry, "pending", sl=sl, tp=tp)
        result   = await place_market_order(api_key, secret, sym, side, str(qty), sl, tp, lev, BYBIT_MARGIN_TYPE)
        trade_id = result.get("result", {}).get("orderId", "")
        trade_tracker.lock(sym, signal.direction.value, entry, trade_id, sl=sl, tp=tp)

        sig_dict.update({"exec_status": "ok", "exec_order_id": trade_id,
                         "exec_qty": qty, "exec_side": side})
        logger.info("✅ BYBIT AUTO-EXEC: %s %s qty=%.3f lev=%d× entry=%.4f", sym, side, qty, lev, entry)

    except Exception as exc:
        err = str(exc)
        logger.error("Bybit AutoExec FAILED %s: %s", sym, err)
        trade_tracker.unlock(sym)
        sig_dict["exec_status"] = "failed"
        sig_dict["exec_error"]  = err
