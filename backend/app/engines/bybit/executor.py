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
    BYBIT_MIN_ORDER_QTY, BYBIT_QTY_STEP, get_bybit_creds,
)
from app.core.trade_tracker import trade_tracker
from app.services.strategy import TradeSignal
from app.engines.sl_tp import candle_anchor_levels, bybit_qty
import app.core.state as state

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


def sign_post(api_key: str, api_secret: str, body: dict) -> tuple[str, dict]:
    """
    Sign a POST request.
    String: ts + apiKey + recvWindow + json_body (COMPACT — no whitespace).

    Uses separators=(',', ':') to strip all spaces. This is the root cause
    of error 10004 when standard json.dumps (which adds spaces) is used.
    """
    ts       = _ts()
    body_str = json.dumps(body, separators=(",", ":"), sort_keys=False, ensure_ascii=True)
    sig      = _sign(api_secret, ts + api_key + BYBIT_RECV_WINDOW + body_str)
    # Return the EXACT compact string so callers send content= not json=.
    # Returning the dict and letting httpx re-encode it adds spaces → 10004.
    return body_str, _auth_headers(api_key, sig, ts)


def raise_on_error(data: object, ctx: str = "") -> None:
    """
    Check a Bybit V5 response dict for retCode != 0 and raise RuntimeError.

    Bybit normally returns {"retCode": 0, ...} on success.  Under load or
    network issues the body can be a bare number (0, 1.0), null, or a list —
    all of which crash data.get() with 'float/NoneType/list object has no
    attribute get'.  Guard here once so every caller is protected.
    """
    if not isinstance(data, dict):
        raise RuntimeError(
            f"Bybit returned non-dict response ({type(data).__name__}: {str(data)[:120]}) [{ctx}]"
        )
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
    raw_list = data.get("result", {}).get("list") or []
    raw_acct = raw_list[0] if raw_list else {}
    # Guard: Bybit can return a malformed list entry (None, float) under load —
    # if the first element isn't a dict, calling .get() on it raises
    # "float/NoneType object has no attribute 'get'". Fall back to {}.
    acct: dict = raw_acct if isinstance(raw_acct, dict) else {}
    eq   = float(acct.get("totalEquity",           0) or 0)
    av   = float(acct.get("totalAvailableBalance", 0) or 0)
    mg   = float(acct.get("totalMarginBalance",    0) or 0)
    # Coin entries can also be malformed — filter to dicts only
    raw_coins = acct.get("coin") or []
    coins = [
        c for c in raw_coins
        if isinstance(c, dict) and float(c.get("walletBalance", 0) or 0) > 0
    ]
    return {
        "accountType":           acct.get("accountType", "UNIFIED"),
        "totalEquity":           round(eq, 2),
        "totalMarginBalance":    round(mg, 2),
        "totalAvailableBalance": round(av, 2),
        "totalAvailable":        round(av, 2),
        "totalMargin":           round(mg, 2),
        "totalUSDT":             round(eq, 2),
        "coin":                  coins,
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
    body_str, headers = sign_post(api_key, secret, body)
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(f"{BYBIT_BASE}/v5/position/switch-isolated",
                             headers=headers, content=body_str)
        d = r.json()
        code = d.get("retCode", -1)
        if code not in (0, 110043, 100028):
            # 100028 = Unified Trading Account — switch-isolated is a Classic-only
            # endpoint. UTA ignores it; leverage is set directly via set-leverage.
            logger.warning("set_margin_mode %s: %s %s", symbol, code, d.get("retMsg"))
        elif code == 100028:
            logger.debug("set_margin_mode %s: UTA account — skip switch-isolated (ok)", symbol)
    except Exception as e:
        logger.warning("set_margin_mode %s: %s", symbol, e)


async def _set_leverage(api_key: str, secret: str, symbol: str,
                        leverage: int, margin_type: str = "ISOLATED") -> None:
    await _set_margin_mode(api_key, secret, symbol, margin_type)
    body = {
        "category": "linear", "symbol": symbol,
        "buyLeverage": str(leverage), "sellLeverage": str(leverage),
    }
    body_str, headers = sign_post(api_key, secret, body)
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(f"{BYBIT_BASE}/v5/position/set-leverage",
                         headers=headers, content=body_str)
    d = r.json()
    code2 = d.get("retCode", -1)
    if code2 not in (0, 110043, 100028):
        # 0      = success
        # 110043 = leverage unchanged (already at this value)
        # 100028 = UTA accounts: isolated set-leverage is Classic-only; UTA
        #          manages leverage per-position via the order directly — skip silently
        logger.warning("set_leverage %s: %s %s", symbol, code2, d.get("retMsg"))
    elif code2 == 100028:
        logger.debug("set_leverage %s: UTA account — isolated leverage skipped (ok)", symbol)


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
    body_str, headers = sign_post(api_key, secret, body)
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(f"{BYBIT_BASE}/v5/order/create",
                         headers=headers, content=body_str)
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
    body_str, headers = sign_post(api_key, secret, body)
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(f"{BYBIT_BASE}/v5/order/create",
                         headers=headers, content=body_str)
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


def _snap_qty(raw: float, symbol: str) -> str:
    """
    Floor qty to the nearest valid step using Decimal arithmetic.

    float-based math.floor is unreliable for small steps — e.g.
    math.floor(0.12 / 0.01) can return 11 in some Python builds due to FP
    representation (0.12 / 0.01 evaluates to 11.999…).  Decimal avoids this.

    retCode 10001 fires whenever qty is not an exact multiple of qtyStep.
    Both integers (XRPUSDT step=1) and sub-cent steps (BTCUSDT step=0.001)
    are handled correctly.  Result is never in scientific notation.

    Self-contained: the step table is inline so a stale/missing config import
    can never cause 'float has no attribute get' on the BYBIT_QTY_STEP reference.
    """
    from decimal import Decimal, ROUND_DOWN
    # Inline step table — single source of truth mirrored from config.py.
    # Kept here so executor.py never crashes if config is stale/wrong type.
    _STEPS: dict[str, float] = {
        "BTCUSDT": 0.001, "ETHUSDT": 0.01,  "SOLUSDT": 0.1,
        "XRPUSDT": 1.0,   "BNBUSDT": 0.01,  "DOGEUSDT": 1.0,
        "AVAXUSDT": 0.1,  "ADAUSDT": 1.0,   "DOTUSDT": 0.1,
        "LINKUSDT": 0.01, "LTCUSDT": 0.01,  "NEARUSDT": 1.0,
        "ATOMUSDT": 0.01, "UNIUSDT": 0.1,
        "1000PEPEUSDT": 100.0, "1000BONKUSDT": 100.0,
        "FARTCOINUSDT": 1.0,   "XPLUSDT": 1.0, "WLFIUSDT": 10.0,
    }
    # Prefer config dict if it is actually a dict (guards against stale float import)
    step_src = BYBIT_QTY_STEP if isinstance(BYBIT_QTY_STEP, dict) else _STEPS
    step_f   = step_src.get(symbol) or _STEPS.get(symbol, 0.001)
    step     = Decimal(str(step_f))
    value    = Decimal(str(raw))
    snapped  = (value / step).to_integral_value(rounding=ROUND_DOWN) * step
    if step >= 1:
        return str(int(snapped))   # "14340"  — no decimal, no scientific notation
    return format(snapped, 'f')    # "0.12"   — never "1.2E-1"


async def fetch_mark_price(symbol: str) -> float:
    """
    Fetch the current MarkPrice for a single linear symbol.
    MarkPrice is what Bybit uses to trigger TP/SL — it differs from lastPrice
    during volatile moves, so using it for validation avoids false 10001 errors.
    Falls back to lastPrice if markPrice is absent.
    """
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(
            f"{BYBIT_BASE}/v5/market/tickers",
            params={"category": "linear", "symbol": symbol},
        )
        r.raise_for_status()
    data = r.json()
    items = data.get("result", {}).get("list") or []
    if not items or not isinstance(items[0], dict):
        raise RuntimeError(f"mark_price: empty response for {symbol}")
    item = items[0]
    mark = float(item.get("markPrice", 0) or 0)
    last = float(item.get("lastPrice",  0) or 0)
    price = mark or last
    if price <= 0:
        raise RuntimeError(f"mark_price: zero price for {symbol}")
    return price


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
        # ── 1. Fetch current MarkPrice ────────────────────────────────────────
        # Use MarkPrice (not signal.entry_price) because:
        #   a) TP/SL triggers are evaluated against MarkPrice on Bybit
        #   b) Market fills near MarkPrice — stale entry_price gives wrong qty
        #   c) Bybit 10001 fires when SL/TP are on wrong side at submission time
        #
        # Try in-memory meta first (updated every 60s by bybit_refresh_loop),
        # then fall back to a live API call if cache is empty or stale.
        mark_price: float = float((state.bybit_meta.get(sym) or {}).get("mark_price") or 0)
        if mark_price <= 0:
            mark_price = await fetch_mark_price(sym)

        # ── 2. Zone-Anchored SL/TP (SMC-correct) ────────────────────────────
        # Pass the OB/FVG zone object from the signal so the SL is anchored at
        # the institutional zone boundary, not an arbitrary recent candle.
        # This eliminates micro-stops from tight consolidation bars.
        is_long    = signal.direction.value == "LONG"
        side       = "Buy" if is_long else "Sell"
        h1_candles = state.bybit_candle_cache.get(sym, {}).get("60", [])
        zone_obj   = getattr(signal, "layer2_zone_obj", None)

        try:
            sl, tp, sl_dist = candle_anchor_levels(
                candles    = h1_candles,
                mark_price = mark_price,
                is_long    = is_long,
                instrument = sym,
                is_bybit   = True,
                zone       = zone_obj,
            )
        except ValueError as ve:
            logger.warning("Bybit AutoExec SKIPPED %s %s — SL/TP anchor: %s", sym, side, ve)
            sig_dict["exec_status"] = "skipped"
            sig_dict["exec_error"]  = f"Skipped: {ve}"
            return

        # ── Patch sig_dict so UI shows ACTUAL execution levels ───────────────
        rr_actual = round(abs(tp - mark_price) / abs(mark_price - sl), 2) if sl != mark_price else 0
        sig_dict["sl"] = sl
        sig_dict["tp"] = tp
        sig_dict["rr"] = rr_actual

        # ── 3. Account balance + risk-sized qty ──────────────────────────────
        acct_data = await fetch_account(api_key, secret)
        equity    = float(acct_data.get("totalEquity",           0) or 0)
        available = float(acct_data.get("totalAvailableBalance", 0) or 0)
        if equity <= 0:
            sig_dict["exec_status"] = "failed"
            sig_dict["exec_error"]  = "Zero account equity"
            return

        clerk_id    = sig_dict.get("clerk_id", "")
        risk_pct    = get_risk_pct(clerk_id, "bybit") if clerk_id else 0.20   # default 20%
        sizing_base = available if available > 0 else equity
        # Risk amount = % of available balance, floored at $1.20 minimum margin
        risk_usd = max(sizing_base * risk_pct, 1.20)

        if sizing_base <= 0:
            sig_dict["exec_status"] = "failed"
            sig_dict["exec_error"]  = f"Insufficient available balance: {available:.2f} USDT"
            return

        lev = _safe_leverage(mark_price, sl, BYBIT_DEFAULT_LEVERAGE)

        # ── Correct quantity formula for linear USDT perpetuals ───────────────
        # For Bybit linear perps: P&L = qty × price_move (USDT, 1:1 per contract).
        # Therefore: qty = risk_usd / sl_dist   (leverage NOT in this formula).
        # Leverage only governs margin: margin = qty × mark_price / lev.
        #
        # Previous formula (risk_usd * lev) / (sl_dist * mark_price) was wrong:
        #   BTC $50k, risk=$100, sl_dist=$500, lev=20 → qty=0.00008 BTC → loss=$0.04
        #   Correct: qty = 100/500 = 0.2 BTC → loss = 0.2 × 500 = $100 ✓
        try:
            qty_raw, margin_used = bybit_qty(
                risk_usd   = risk_usd,
                sl_dist    = sl_dist,
                mark_price = mark_price,
                leverage   = lev,
                available  = sizing_base,
            )
        except ValueError as ve:
            sig_dict["exec_status"] = "failed"
            sig_dict["exec_error"]  = f"Qty sizing error: {ve}"
            return

        min_qty = BYBIT_MIN_ORDER_QTY.get(sym, 0.001) if isinstance(BYBIT_MIN_ORDER_QTY, dict) else 0.001
        qty_str = _snap_qty(max(qty_raw, min_qty), sym)

        logger.info(
            "Bybit AutoExec %s %s: mark=%.5f sl=%.5f tp=%.5f rr=1:%.2f "
            "sl_dist=%.5f risk=$%.2f qty=%s lev=%d× margin=$%.2f",
            sym, side, mark_price, sl, tp, rr_actual,
            sl_dist, risk_usd, qty_str, lev, margin_used,
        )

        trade_tracker.lock(sym, signal.direction.value, mark_price, "pending", sl=sl, tp=tp)
        result   = await place_market_order(api_key, secret, sym, side, qty_str, sl, tp, lev, BYBIT_MARGIN_TYPE)
        trade_id = result.get("result", {}).get("orderId", "") if isinstance(result, dict) else ""
        trade_tracker.lock(sym, signal.direction.value, mark_price, trade_id, sl=sl, tp=tp)

        sig_dict.update({
            "exec_status":     "ok",
            "exec_order_id":   trade_id,
            "exec_qty":        qty_str,
            "exec_side":       side,
            "exec_mark_price": mark_price,
            "exec_sl":         sl,
            "exec_tp":         tp,
            "exec_rr":         rr_actual,
            "exec_margin":     round(margin_used, 2),
        })
        logger.info("✅ BYBIT AUTO-EXEC: %s %s qty=%s lev=%d× mark=%.5f sl=%.5f tp=%.5f rr=1:%.2f",
                    sym, side, qty_str, lev, mark_price, sl, tp, rr_actual)

    except Exception as exc:
        import traceback as _tb
        err = str(exc)
        logger.error("Bybit AutoExec FAILED %s: %s\n%s", sym, err, _tb.format_exc())
        trade_tracker.unlock(sym)
        sig_dict["exec_status"] = "failed"
        sig_dict["exec_error"]  = err