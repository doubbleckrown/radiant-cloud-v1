"""
FX Radiant — FastAPI Backend
============================
• Clerk JWT Authentication (verified against Clerk JWKS — no manual signup/login)
• Oanda v20 WebSocket price streaming
• SMC Confluence Engine — fires signal alerts at 100 % confidence
• Dynamic SL / Breakeven risk engine
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# ── Load .env BEFORE any os.getenv() call ─────────────────────────────────────
try:
    from dotenv import load_dotenv
    _env_path = Path(__file__).resolve().parent.parent / ".env"
    _loaded   = load_dotenv(_env_path, override=False)
    if _loaded:
        print(f"[fx-radiant] ✅ .env loaded from {_env_path}", flush=True)
    else:
        print(f"[fx-radiant] ⚠️  No .env found at {_env_path} — using shell env only", flush=True)
except ImportError:
    print("[fx-radiant] ⚠️  python-dotenv not installed", flush=True)

import httpx
import jwt as _jwt                          # PyJWT — RS256 Clerk token verification
from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.services.strategy import Candle, SMCConfluenceEngine, TradeSignal

# ─────────────────────────────────────────────────────────────────────────────
#  Config
# ─────────────────────────────────────────────────────────────────────────────

OANDA_API_KEY   = os.getenv("OANDA_API_KEY", "")
OANDA_ACCOUNT   = os.getenv("OANDA_ACCOUNT_ID", "")
OANDA_BASE      = os.getenv("OANDA_BASE_URL",   "https://api-fxpractice.oanda.com")
OANDA_STREAM    = os.getenv("OANDA_STREAM_URL", "https://stream-fxpractice.oanda.com")

# Clerk JWKS URL — derived from your publishable key's embedded domain.
# No Clerk secret key is needed on the backend; we verify JWTs locally using
# the public RS256 keys from the JWKS endpoint.
CLERK_JWKS_URL = os.getenv(
    "CLERK_JWKS_URL",
    "https://immune-donkey-10.clerk.accounts.dev/.well-known/jwks.json",
)

# OneSignal push notification config (optional — push is silently disabled if absent)
ONESIGNAL_APP_ID  = os.getenv("ONESIGNAL_APP_ID",  "")
ONESIGNAL_REST_KEY = os.getenv("ONESIGNAL_REST_KEY", "")

INSTRUMENTS = [
    "EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD",
    "NZD_USD", "USD_CAD", "USD_CHF",
    "XAU_USD",
    "NAS100_USD", "US30_USD", "SPX500_USD",
    "GER30_EUR",  "UK100_GBP", "J225_USD",
    "BTC_USD",
]
GRANULARITIES = ["M5", "M15", "H1"]

logger = logging.getLogger("fx-radiant")
logging.basicConfig(level=logging.INFO)


# ─────────────────────────────────────────────────────────────────────────────
#  In-memory stores
# ─────────────────────────────────────────────────────────────────────────────

# Clerk JWKS cache: {kid: RSA public-key object}
_clerk_jwks: dict[str, Any] = {}

# Per-user settings keyed by Clerk user ID (the "sub" claim from the JWT).
# Clerk owns identity (name, email, password).
# We only persist what Clerk doesn't know: auto-trade flag, risk %, Oanda hint.
_user_settings: dict[str, dict] = {}

def _settings(clerk_id: str) -> dict:
    return _user_settings.setdefault(clerk_id, {
        "auto_trade_enabled": False,
        "risk_pct":           1.0,
        "oanda_key_hint":     "",
    })

# Candle cache
_candle_cache: dict[str, dict[str, list[Candle]]] = {
    ins: {gran: [] for gran in GRANULARITIES} for ins in INSTRUMENTS
}

_latest_prices:  dict[str, float]      = {}
_ws_clients:     set[WebSocket]        = set()
_signal_history: dict[str, list[dict]] = {ins: [] for ins in INSTRUMENTS}
_engines:        dict[str, SMCConfluenceEngine] = {
    ins: SMCConfluenceEngine(ins) for ins in INSTRUMENTS
}

# OneSignal player IDs registered by the frontend.
# In production you'd persist these to a database; in-memory is fine for a
# single-user deployment because Render restarts are infrequent.
_push_subscriptions: set[str] = set()


# ─────────────────────────────────────────────────────────────────────────────
#  Clerk JWT helpers
# ─────────────────────────────────────────────────────────────────────────────

async def _fetch_clerk_jwks() -> None:
    """
    Fetch Clerk's public RS256 keys and cache them by key-id (kid).
    Called on startup; re-called automatically when an unknown kid is seen
    (Clerk rotates keys infrequently but this handles it gracefully).
    """
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(CLERK_JWKS_URL)
            resp.raise_for_status()
        keys = {}
        for key_data in resp.json().get("keys", []):
            kid = key_data.get("kid")
            if kid:
                public_key = _jwt.algorithms.RSAAlgorithm.from_jwk(key_data)
                keys[kid] = public_key
        _clerk_jwks.update(keys)
        logger.info("Clerk JWKS: loaded %d key(s)", len(keys))
    except Exception as exc:
        logger.error("Could not load Clerk JWKS: %s — protected routes will 401 until resolved", exc)


async def _verify_clerk_token(raw_token: str) -> dict:
    """
    Verify a Clerk-issued JWT and return its decoded payload.
    Raises HTTPException(401) on any failure.
    """
    if not raw_token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing token")
    try:
        header = _jwt.get_unverified_header(raw_token)
        kid    = header.get("kid")
        pub    = _clerk_jwks.get(kid)

        if pub is None:
            # Unknown kid — Clerk may have rotated keys; try refreshing once
            await _fetch_clerk_jwks()
            pub = _clerk_jwks.get(kid)

        if pub is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unknown signing key")

        payload = _jwt.decode(
            raw_token,
            pub,
            algorithms=["RS256"],
            # Clerk puts the client ID in "azp" (authorised party), not "aud".
            # verify_aud=False is the correct and documented setting for Clerk JWTs.
            options={"verify_aud": False},
        )
    except _jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token expired")
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("JWT decode error: %s", exc)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token")

    clerk_id = payload.get("sub")
    if not clerk_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "No user ID in token")

    return payload


async def get_current_user(request: Request) -> dict:
    """
    FastAPI dependency — validates the Clerk Bearer token from the
    Authorization header and returns the decoded JWT payload.
    """
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing Authorization header")
    return await _verify_clerk_token(auth.split(" ", 1)[1].strip())


# ─────────────────────────────────────────────────────────────────────────────
#  Oanda v20 helpers  (UNTOUCHED)
# ─────────────────────────────────────────────────────────────────────────────

def _oanda_credentials_ok() -> bool:
    return bool(
        os.environ.get("OANDA_API_KEY",    "").strip()
        and os.environ.get("OANDA_ACCOUNT_ID", "").strip()
    )


def _oanda_headers() -> dict:
    key = os.environ.get("OANDA_API_KEY", "").strip()
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


async def fetch_candles(instrument: str, granularity: str, count: int = 250) -> list[Candle]:
    if not _oanda_credentials_ok():
        raise RuntimeError("OANDA credentials not set")
    url    = f"{OANDA_BASE}/v3/instruments/{instrument}/candles"
    params = {"granularity": granularity, "count": count, "price": "M"}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url, headers=_oanda_headers(), params=params)
        resp.raise_for_status()
    candles = []
    for c in resp.json().get("candles", []):
        if c["complete"]:
            m = c["mid"]
            candles.append(Candle(
                time   = int(datetime.fromisoformat(c["time"].replace("Z", "+00:00")).timestamp()),
                open   = float(m["o"]), high=float(m["h"]),
                low    = float(m["l"]), close=float(m["c"]),
                volume = float(c.get("volume", 0)),
            ))
    return candles


async def fetch_account_summary() -> dict:
    if not _oanda_credentials_ok():
        raise RuntimeError("OANDA credentials not set")
    url = f"{OANDA_BASE}/v3/accounts/{OANDA_ACCOUNT}/summary"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url, headers=_oanda_headers())
        resp.raise_for_status()
    return resp.json().get("account", {})


async def fetch_open_trades() -> list:
    if not _oanda_credentials_ok():
        raise RuntimeError("OANDA credentials not set")
    url = f"{OANDA_BASE}/v3/accounts/{OANDA_ACCOUNT}/openTrades"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url, headers=_oanda_headers())
        resp.raise_for_status()
    return resp.json().get("trades", [])


async def fetch_trade_history(count: int = 50) -> list:
    if not _oanda_credentials_ok():
        raise RuntimeError("OANDA credentials not set")
    url    = f"{OANDA_BASE}/v3/accounts/{OANDA_ACCOUNT}/trades"
    params = {"state": "CLOSED", "count": str(count)}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url, headers=_oanda_headers(), params=params)
        resp.raise_for_status()
    return resp.json().get("trades", [])


async def place_market_order(instrument: str, units: int, stop_loss: float, take_profit: float) -> dict:
    if not _oanda_credentials_ok():
        raise RuntimeError("OANDA credentials not set")
    url  = f"{OANDA_BASE}/v3/accounts/{OANDA_ACCOUNT}/orders"
    body = {"order": {
        "type": "MARKET", "instrument": instrument, "units": str(units),
        "stopLossOnFill":   {"price": f"{stop_loss:.5f}"},
        "takeProfitOnFill": {"price": f"{take_profit:.5f}"},
        "timeInForce": "FOK",
    }}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, headers=_oanda_headers(), json=body)
        resp.raise_for_status()
    return resp.json()


# ─────────────────────────────────────────────────────────────────────────────
#  Background tasks  (UNTOUCHED)
# ─────────────────────────────────────────────────────────────────────────────

async def broadcast(message: dict) -> None:
    dead: set[WebSocket] = set()
    payload = json.dumps(message)
    for ws in _ws_clients:
        try:
            await ws.send_text(payload)
        except Exception:
            dead.add(ws)
    _ws_clients.difference_update(dead)


async def _send_onesignal_push(title: str, body: str, data: dict) -> None:
    """
    Send a push notification to all registered devices via the OneSignal REST API.
    Silently skips if ONESIGNAL_APP_ID / ONESIGNAL_REST_KEY are not set,
    or if there are no registered subscribers.
    """
    if not ONESIGNAL_APP_ID or not ONESIGNAL_REST_KEY:
        return
    if not _push_subscriptions:
        return
    payload = {
        "app_id":                       ONESIGNAL_APP_ID,
        "include_subscription_ids":     list(_push_subscriptions),
        "headings":                     {"en": title},
        "contents":                     {"en": body},
        "data":                         data,
        # Android: make the device vibrate
        "android_vibrate":              True,
        # iOS / Android: custom sound
        "ios_sound":                    "default",
        "android_sound":                "default",
        # Collapse duplicate signal notifications for the same instrument
        "collapse_id":                  data.get("instrument", "fx-radiant"),
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                "https://onesignal.com/api/v1/notifications",
                headers={
                    "Authorization": f"Basic {ONESIGNAL_REST_KEY}",
                    "Content-Type":  "application/json",
                },
                json=payload,
            )
        if resp.status_code not in (200, 201):
            logger.warning("OneSignal push failed: %s — %s", resp.status_code, resp.text[:200])
        else:
            logger.info("📲 Push sent to %d subscriber(s): %s", len(_push_subscriptions), body[:60])
    except Exception as exc:
        logger.warning("OneSignal push error: %s", exc)


async def candle_refresh_loop() -> None:
    FETCH_TIMEOUT = 25.0
    MAX_BACKOFF   = 40.0
    fail_counts: dict[str, int] = {ins: 0 for ins in INSTRUMENTS}

    async def _fetch_safe(ins: str, gran: str) -> list[Candle] | None:
        try:
            candles = await asyncio.wait_for(fetch_candles(ins, gran), timeout=FETCH_TIMEOUT)
            fail_counts[ins] = 0
            return candles
        except asyncio.TimeoutError:
            logger.warning("Timeout %ss: %s %s", FETCH_TIMEOUT, ins, gran)
        except Exception as exc:
            logger.warning("Candle error %s %s: %s", ins, gran, exc)
        fail_counts[ins] = fail_counts.get(ins, 0) + 1
        return None

    while True:
        try:
            for ins in INSTRUMENTS:
                fails   = fail_counts.get(ins, 0)
                backoff = min(5.0 * (2 ** max(0, fails - 1)), MAX_BACKOFF) if fails > 0 else 0.0
                if backoff:
                    await asyncio.sleep(backoff)

                for gran in GRANULARITIES:
                    result = await _fetch_safe(ins, gran)
                    if result is not None:
                        _candle_cache[ins][gran] = result

                try:
                    h1    = _candle_cache[ins]["H1"]
                    price = _latest_prices.get(ins)
                    if price and len(h1) >= 210:
                        signal: Optional[TradeSignal] = _engines[ins].analyze(h1, price, int(time.time()))
                        if signal:
                            sig_dict = {
                                "type":       "SIGNAL",
                                "instrument": signal.instrument,
                                "direction":  signal.direction.value,
                                "entry":      round(signal.entry_price,    5),
                                "sl":         round(signal.stop_loss,      5),
                                "tp":         round(signal.take_profit,    5),
                                "breakeven":  round(signal.breakeven_price, 5),
                                "rr":         signal.risk_reward,
                                "confidence": signal.confidence,
                                "layer1":     signal.layer1_bias,
                                "layer2":     signal.layer2_zone,
                                "layer3":     signal.layer3_mss,
                                "timestamp":  signal.timestamp,
                            }
                            _signal_history[ins] = ([sig_dict] + _signal_history[ins])[:50]
                            await broadcast(sig_dict)
                            logger.info("🟢 SIGNAL: %s %s", ins, signal.direction.value)

                            # ── Push notification for high-confluence setups ──────────────
                            if signal.confidence >= 95:
                                ins_label  = ins.replace("_", "/")
                                dir_label  = signal.direction.value.title()
                                entry_fmt  = f"{signal.entry_price:.5f}"
                                push_title = f"🚨 High Probability Setup: {ins_label} {dir_label}"
                                push_body  = (
                                    f"Entry at {entry_fmt}  ·  "
                                    f"{signal.confidence}% confluence  ·  "
                                    f"R:R 1:{signal.risk_reward}"
                                )
                                asyncio.create_task(_send_onesignal_push(
                                    title = push_title,
                                    body  = push_body,
                                    data  = {
                                        "instrument": ins,
                                        "direction":  signal.direction.value,
                                        "entry":      round(signal.entry_price, 5),
                                        "confidence": signal.confidence,
                                    },
                                ))
                except Exception as smc_exc:
                    logger.warning("SMC error %s: %s", ins, smc_exc)

        except Exception as loop_exc:
            logger.error("candle_refresh_loop error: %s — restart in 10s", loop_exc)
            await asyncio.sleep(10)
            continue

        await asyncio.sleep(60)


async def price_stream_loop() -> None:
    while True:
        if not _oanda_credentials_ok():
            logger.warning("price_stream_loop: credentials missing — retry in 30s")
            await asyncio.sleep(30)
            continue
        instruments_param = "%2C".join(INSTRUMENTS)
        url = (
            f"{OANDA_STREAM}/v3/accounts/{OANDA_ACCOUNT}"
            f"/pricing/stream?instruments={instruments_param}"
        )
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("GET", url, headers=_oanda_headers()) as resp:
                    async for line in resp.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            tick = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if tick.get("type") == "PRICE":
                            ins = tick["instrument"]
                            bid = float(tick["bids"][0]["price"])
                            ask = float(tick["asks"][0]["price"])
                            mid = round((bid + ask) / 2, 5)
                            _latest_prices[ins] = mid
                            await broadcast({
                                "type": "TICK", "instrument": ins,
                                "bid": bid, "ask": ask, "mid": mid, "time": tick["time"],
                            })
        except Exception as exc:
            logger.error("Stream error: %s — reconnecting in 5s", exc)
            await asyncio.sleep(5)


# ─────────────────────────────────────────────────────────────────────────────
#  App lifecycle
# ─────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("━" * 60)
    logger.info("  FX Radiant v2 — Clerk auth mode")
    await _fetch_clerk_jwks()

    _key_live     = os.environ.get("OANDA_API_KEY",    "").strip()
    _account_live = os.environ.get("OANDA_ACCOUNT_ID", "").strip()
    logger.info("  OANDA_API_KEY   : %s", "✅ set" if _key_live     else "❌ MISSING")
    logger.info("  OANDA_ACCOUNT_ID: %s", "✅ set" if _account_live else "❌ MISSING")
    logger.info("  CLERK_JWKS_URL  : %s", CLERK_JWKS_URL)
    logger.info("  Clerk keys cached: %d", len(_clerk_jwks))
    logger.info("━" * 60)

    async def _safe_seed(ins: str, gran: str):
        try:
            return ins, gran, await asyncio.wait_for(fetch_candles(ins, gran), timeout=20.0)
        except Exception as exc:
            logger.warning("Seed %s %s: %s", ins, gran, exc)
        return ins, gran, None

    results = await asyncio.gather(*[_safe_seed(i, g) for i in INSTRUMENTS for g in GRANULARITIES])
    seeded  = 0
    for ins, gran, candles in results:
        if candles is not None:
            _candle_cache[ins][gran] = candles
            seeded += 1
    logger.info("Candle seed: %d/%d loaded", seeded, len(results))

    asyncio.create_task(price_stream_loop())
    asyncio.create_task(candle_refresh_loop())
    yield


# ─────────────────────────────────────────────────────────────────────────────
#  FastAPI App + CORS + Global error handler
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="FX Radiant API",
    version="2.0.0",
    description="SMC/ICT trading backend — Clerk JWT auth",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def _global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled exception on %s %s", request.method, request.url)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
        headers={"Access-Control-Allow-Origin": "*"},
    )


# ─────────────────────────────────────────────────────────────────────────────
#  Pydantic schemas
# ─────────────────────────────────────────────────────────────────────────────

class OrderRequest(BaseModel):
    instrument:  str
    units:       int
    stop_loss:   float
    take_profit: float


class PushRegisterRequest(BaseModel):
    player_id: str


class UserSettingsRequest(BaseModel):
    auto_trade_enabled: Optional[bool]  = None
    risk_pct:           Optional[float] = None
    oanda_key_hint:     Optional[str]   = None
    display_name:       Optional[str]   = None


# ─────────────────────────────────────────────────────────────────────────────
#  Auth / user routes
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/auth/me")
async def me(payload: dict = Depends(get_current_user)):
    """
    Return the Clerk user's backend settings.
    Called by the frontend after sign-in to hydrate auto_trade_enabled etc.
    Name and email come from Clerk directly on the frontend — not stored here.
    """
    clerk_id = payload["sub"]
    s = _settings(clerk_id)
    return {
        "clerk_id":           clerk_id,
        "auto_trade_enabled": s["auto_trade_enabled"],
        "risk_pct":           s["risk_pct"],
        "oanda_key_hint":     s["oanda_key_hint"],
    }


@app.patch("/api/users/me/settings")
async def update_user_settings(
    body:    UserSettingsRequest,
    payload: dict = Depends(get_current_user),
):
    clerk_id = payload["sub"]
    s = _settings(clerk_id)
    if body.auto_trade_enabled is not None:
        s["auto_trade_enabled"] = body.auto_trade_enabled
        logger.info("auto_trade=%s  clerk_id=%s", body.auto_trade_enabled, clerk_id)
    if body.risk_pct is not None:
        s["risk_pct"] = max(0.1, min(10.0, float(body.risk_pct)))
    if body.oanda_key_hint is not None:
        hint = body.oanda_key_hint.strip()
        s["oanda_key_hint"] = hint[-4:] if hint else ""
    return {
        "clerk_id":           clerk_id,
        "auto_trade_enabled": s["auto_trade_enabled"],
        "risk_pct":           s["risk_pct"],
        "oanda_key_hint":     s["oanda_key_hint"],
    }


@app.post("/api/push/register")
async def register_push(
    body:    PushRegisterRequest,
    payload: dict = Depends(get_current_user),
):
    """
    Register a OneSignal player/subscription ID for push notifications.
    The frontend sends this after the user grants notification permission.
    """
    pid = body.player_id.strip()
    if not pid:
        raise HTTPException(400, "player_id is required")
    _push_subscriptions.add(pid)
    logger.info("📲 Push registered: %s… (%d total)", pid[:8], len(_push_subscriptions))
    return {"registered": True, "total_subscribers": len(_push_subscriptions)}


# ─────────────────────────────────────────────────────────────────────────────
#  Market data routes
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/markets")
async def get_markets(_: dict = Depends(get_current_user)):
    result = []
    for ins in INSTRUMENTS:
        price = _latest_prices.get(ins, 0.0)
        h1    = _candle_cache[ins]["H1"]
        state = _engines[ins].get_partial_state(h1, price) if len(h1) >= 210 else None
        result.append({
            "instrument": ins,
            "price":      price,
            "confidence": state.confidence        if state else 0,
            "bias":       state.layer1_bias.value if state else "NEUTRAL",
        })
    return result


@app.get("/api/markets/{instrument}/candles")
async def get_candles(instrument: str, granularity: str = "H1", _: dict = Depends(get_current_user)):
    if instrument not in _candle_cache:
        raise HTTPException(404, "Instrument not found")
    candles = _candle_cache[instrument].get(granularity, [])
    return [
        {"t": c.time, "o": c.open, "h": c.high, "l": c.low, "c": c.close, "v": c.volume}
        for c in candles[-500:]
    ]


@app.get("/api/markets/{instrument}/analysis")
async def get_analysis(instrument: str, _: dict = Depends(get_current_user)):
    if instrument not in _engines:
        raise HTTPException(404, "Instrument not found")
    price = _latest_prices.get(instrument, 0.0)
    h1    = _candle_cache[instrument]["H1"]
    state = _engines[instrument].get_partial_state(h1, price) if len(h1) >= 210 else None
    if not state:
        return {"confidence": 0}
    return {
        "instrument": instrument, "price": price, "confidence": state.confidence,
        "layer1": {"bias": state.layer1_bias.value, "active": state.layer1_bias.value != "NEUTRAL"},
        "layer2": {"active": state.layer2_active, "zone": str(state.layer2_zone) if state.layer2_zone else None},
        "layer3": {"mss": state.layer3_mss},
    }


@app.get("/api/signals")
async def get_signals(_: dict = Depends(get_current_user)):
    all_signals = []
    for ins_signals in _signal_history.values():
        all_signals.extend(ins_signals)
    return sorted(all_signals, key=lambda s: s["timestamp"], reverse=True)[:100]


# ─────────────────────────────────────────────────────────────────────────────
#  Account & Orders
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/account")
async def get_account(_: dict = Depends(get_current_user)):
    try:
        return await fetch_account_summary()
    except Exception as e:
        raise HTTPException(503, f"Oanda error: {e}")


@app.get("/api/account/trades")
async def get_open_trades(_: dict = Depends(get_current_user)):
    try:
        return await fetch_open_trades()
    except Exception as e:
        raise HTTPException(503, f"Oanda error: {e}")


@app.get("/api/account/history")
async def get_trade_history(_: dict = Depends(get_current_user)):
    try:
        return await fetch_trade_history(count=50)
    except Exception as e:
        raise HTTPException(503, f"Oanda error: {e}")


@app.post("/api/orders")
async def create_order(body: OrderRequest, _: dict = Depends(get_current_user)):
    try:
        return await place_market_order(body.instrument, body.units, body.stop_loss, body.take_profit)
    except Exception as e:
        raise HTTPException(503, f"Order error: {e}")


# ─────────────────────────────────────────────────────────────────────────────
#  WebSocket — real-time feed
# ─────────────────────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str = ""):
    """
    Verify the Clerk JWT once on connection, then stream ticks and signals.
    Frontend passes the Clerk session token as the `token` query param.
    """
    try:
        await _verify_clerk_token(token)
    except HTTPException:
        await ws.close(code=4001)
        return

    await ws.accept()
    _ws_clients.add(ws)
    logger.info("WS connected. Total: %d", len(_ws_clients))

    await ws.send_text(json.dumps({
        "type":    "SNAPSHOT",
        "prices":  _latest_prices,
        "signals": {ins: _signal_history[ins][:5] for ins in INSTRUMENTS},
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
                    cached_price = _latest_prices.get(ins)
                    if cached_price is not None:
                        await ws.send_text(json.dumps({
                            "type": "TICK", "instrument": ins,
                            "bid": cached_price, "ask": cached_price,
                            "mid": cached_price, "time": str(int(time.time())),
                        }))
                    signals = _signal_history.get(ins, [])
                    if signals:
                        await ws.send_text(json.dumps({
                            "type": "SIGNAL_HISTORY", "instrument": ins, "signals": signals[:5],
                        }))

    except WebSocketDisconnect:
        _ws_clients.discard(ws)
        logger.info("WS disconnected. Total: %d", len(_ws_clients))


# ─────────────────────────────────────────────────────────────────────────────
#  Health
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status":        "ok",
        "auth":          "clerk",
        "jwks_keys":     len(_clerk_jwks),
        "ws_clients":    len(_ws_clients),
        "cached_prices": len(_latest_prices),
        "timestamp":     int(time.time()),
    }