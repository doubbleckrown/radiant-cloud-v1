"""
FX Radiant — FastAPI Backend
============================
• JWT Authentication (signup / login / refresh)
• Oanda v20 WebSocket price streaming
• SMC Confluence Engine — fires signal alerts at 100 % confidence
• Dynamic SL / Breakeven risk engine
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

# ── Load .env BEFORE any os.getenv() call ─────────────────────────────────────
# Uvicorn does NOT load .env automatically.  Without this block every
# os.getenv("OANDA_API_KEY") call returns "" and every Oanda request fails
# with "Illegal header value b'Bearer '".
#
# The .env file should sit next to this file's parent directory:
#   backend/
#   ├── .env            ← put OANDA_API_KEY=... here
#   └── app/
#       └── main.py     ← this file
#
# override=False means shell-level env vars (e.g. from a Docker --env flag)
# take precedence over the .env file, which is the expected production behaviour.
try:
    from dotenv import load_dotenv
    _env_path = Path(__file__).resolve().parent.parent / ".env"
    _loaded   = load_dotenv(_env_path, override=False)
    if _loaded:
        print(f"[fx-radiant] ✅ .env loaded from {_env_path}", flush=True)
    else:
        print(f"[fx-radiant] ⚠️  No .env found at {_env_path} — using shell environment only", flush=True)
except ImportError:
    print("[fx-radiant] ⚠️  python-dotenv not installed — run: pip install python-dotenv==1.0.1", flush=True)

import httpx
from fastapi import (
    Depends, FastAPI, HTTPException, Request, WebSocket,
    WebSocketDisconnect, status,
)
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
import bcrypt as _bcrypt
from pydantic import BaseModel

from app.services.strategy import Candle, SMCConfluenceEngine, TradeSignal

# ─────────────────────────────────────────────────────────────────────────────
#  Config (use real env vars in production)
# ─────────────────────────────────────────────────────────────────────────────

SECRET_KEY      = os.getenv("SECRET_KEY", "fx-radiant-super-secret-change-me")
ALGORITHM       = "HS256"
ACCESS_EXPIRE   = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "30"))
REFRESH_EXPIRE  = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS",   "7"))

OANDA_API_KEY   = os.getenv("OANDA_API_KEY", "")
OANDA_ACCOUNT   = os.getenv("OANDA_ACCOUNT_ID", "")
OANDA_BASE      = os.getenv("OANDA_BASE_URL", "https://api-fxpractice.oanda.com")
OANDA_STREAM    = os.getenv("OANDA_STREAM_URL", "https://stream-fxpractice.oanda.com")

INSTRUMENTS = [
    # ── Forex majors ──────────────────────────────────────
    "EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD",
    "NZD_USD", "USD_CAD", "USD_CHF",
    # ── Metals ────────────────────────────────────────────
    "XAU_USD",
    # ── Indices ───────────────────────────────────────────
    "NAS100_USD", "US30_USD", "SPX500_USD",
    "GER30_EUR",  "UK100_GBP", "J225_USD",
    # ── Crypto ────────────────────────────────────────────
    "BTC_USD",
]
GRANULARITIES = ["M5", "M15", "H1"]

logger = logging.getLogger("fx-radiant")
logging.basicConfig(level=logging.INFO)


# ─────────────────────────────────────────────────────────────────────────────
#  In-memory stores (replace with Redis / Postgres in production)
# ─────────────────────────────────────────────────────────────────────────────

# ── User store — file-backed so accounts survive Render sleep/restarts ──────
# Render free tier restarts Python on every cold-start (after ~15 min idle).
# Storing users in a JSON file on disk means they persist across sleep cycles.
# (They are wiped on a full re-deploy, but NOT on idle restarts.)
_USERS_FILE = Path(__file__).resolve().parent.parent / "users.json"

def _load_users() -> dict:
    try:
        if _USERS_FILE.exists():
            import json as _json
            return _json.loads(_USERS_FILE.read_text())
    except Exception:
        pass
    return {}

def _save_users(db: dict) -> None:
    try:
        import json as _json
        _USERS_FILE.write_text(_json.dumps(db))
    except Exception as exc:
        logger.warning("Could not persist users: %s", exc)

_users_db: dict[str, dict] = _load_users()

# {instrument: {granularity: [Candle]}}
_candle_cache: dict[str, dict[str, list[Candle]]] = {
    ins: {gran: [] for gran in GRANULARITIES} for ins in INSTRUMENTS
}

# Latest mid-prices
_latest_prices: dict[str, float] = {}

# Active WebSocket connections
_ws_clients: set[WebSocket] = set()

# Signal history (last 50 per instrument)
_signal_history: dict[str, list[dict]] = {ins: [] for ins in INSTRUMENTS}

# SMC engines per instrument
_engines: dict[str, SMCConfluenceEngine] = {
    ins: SMCConfluenceEngine(ins) for ins in INSTRUMENTS
}


# ─────────────────────────────────────────────────────────────────────────────
#  Auth helpers
# ─────────────────────────────────────────────────────────────────────────────

oauth2_scheme  = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def hash_password(plain: str) -> str:
    # Use bcrypt directly — passlib 1.7.4 is incompatible with bcrypt 4.x
    # (bcrypt 4.0 removed __about__ which passlib reads on every hash call)
    return _bcrypt.hashpw(plain.encode("utf-8"), _bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    return _bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))


def create_token(data: dict, expires_delta: timedelta) -> str:
    payload = data.copy()
    payload["exp"] = datetime.now(timezone.utc) + expires_delta
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def create_access_token(email: str) -> str:
    return create_token({"sub": email, "type": "access"}, timedelta(minutes=ACCESS_EXPIRE))


def create_refresh_token(email: str) -> str:
    return create_token({"sub": email, "type": "refresh"}, timedelta(days=REFRESH_EXPIRE))


async def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email: str = payload.get("sub")
        if email is None or payload.get("type") != "access":
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    user = _users_db.get(email)
    if not user:
        raise credentials_exception
    return user


# ─────────────────────────────────────────────────────────────────────────────
#  Oanda v20 helpers
# ─────────────────────────────────────────────────────────────────────────────

def _oanda_credentials_ok() -> bool:
    """
    Return True only when both required Oanda credentials are non-empty.

    Reads from os.environ DIRECTLY — not from the module-level OANDA_API_KEY
    constant — so this always reflects the live environment even if dotenv
    hadn't populated os.environ before the constant was snapshotted at import.
    """
    return bool(
        os.environ.get("OANDA_API_KEY", "").strip()
        and os.environ.get("OANDA_ACCOUNT_ID", "").strip()
    )


def _oanda_headers() -> dict:
    """
    Build the Oanda Authorization header fresh on every call.

    WHY READ os.environ DIRECTLY INSTEAD OF THE MODULE CONSTANT
    ─────────────────────────────────────────────────────────────
    `OANDA_API_KEY` (the module-level string) is set once at import time via
    os.getenv().  If the .env file was absent or not yet loaded at that exact
    moment, the string is permanently frozen as "".  Even though this is a
    function (not a frozen dict), referencing `OANDA_API_KEY` here would still
    return the frozen empty string.

    Reading `os.environ.get(...)` instead always returns the live value, which
    handles the race between dotenv loading and module import, and also lets
    the key be injected via shell export after the process starts (useful for
    debugging without a restart).
    """
    key = os.environ.get("OANDA_API_KEY", "").strip()
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type":  "application/json",
    }


async def fetch_candles(
    instrument: str,
    granularity: str,
    count: int = 250,
) -> list[Candle]:
    if not _oanda_credentials_ok():
        raise RuntimeError("OANDA_API_KEY / OANDA_ACCOUNT_ID not set — check backend/.env")
    url = f"{OANDA_BASE}/v3/instruments/{instrument}/candles"
    params = {"granularity": granularity, "count": count, "price": "M"}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url, headers=_oanda_headers(), params=params)
        resp.raise_for_status()
    candles = []
    for c in resp.json().get("candles", []):
        if c["complete"]:
            m = c["mid"]
            candles.append(Candle(
                time=int(datetime.fromisoformat(c["time"].replace("Z", "+00:00")).timestamp()),
                open=float(m["o"]), high=float(m["h"]),
                low=float(m["l"]),  close=float(m["c"]),
                volume=float(c.get("volume", 0)),
            ))
    return candles


async def fetch_account_summary() -> dict:
    if not _oanda_credentials_ok():
        raise RuntimeError("OANDA_API_KEY / OANDA_ACCOUNT_ID not set — check backend/.env")
    url = f"{OANDA_BASE}/v3/accounts/{OANDA_ACCOUNT}/summary"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url, headers=_oanda_headers())
        resp.raise_for_status()
    return resp.json().get("account", {})


async def fetch_open_trades() -> list:
    """Return all currently open trades for the account."""
    if not _oanda_credentials_ok():
        raise RuntimeError("OANDA credentials not set")
    url = f"{OANDA_BASE}/v3/accounts/{OANDA_ACCOUNT}/openTrades"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url, headers=_oanda_headers())
        resp.raise_for_status()
    return resp.json().get("trades", [])


async def fetch_trade_history(count: int = 50) -> list:
    """Return the most recent closed trades for the account."""
    if not _oanda_credentials_ok():
        raise RuntimeError("OANDA credentials not set")
    url = f"{OANDA_BASE}/v3/accounts/{OANDA_ACCOUNT}/trades"
    params = {"state": "CLOSED", "count": str(count)}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url, headers=_oanda_headers(), params=params)
        resp.raise_for_status()
    return resp.json().get("trades", [])


async def place_market_order(
    instrument: str,
    units: int,   # negative = short
    stop_loss: float,
    take_profit: float,
) -> dict:
    if not _oanda_credentials_ok():
        raise RuntimeError("OANDA_API_KEY / OANDA_ACCOUNT_ID not set — check backend/.env")
    url  = f"{OANDA_BASE}/v3/accounts/{OANDA_ACCOUNT}/orders"
    body = {
        "order": {
            "type":       "MARKET",
            "instrument": instrument,
            "units":      str(units),
            "stopLossOnFill":   {"price": f"{stop_loss:.5f}"},
            "takeProfitOnFill": {"price": f"{take_profit:.5f}"},
            "timeInForce": "FOK",
        }
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, headers=_oanda_headers(), json=body)
        resp.raise_for_status()
    return resp.json()


# ─────────────────────────────────────────────────────────────────────────────
#  Background tasks
# ─────────────────────────────────────────────────────────────────────────────

async def broadcast(message: dict) -> None:
    """
    Send a JSON message to every connected WebSocket client.

    WHY .difference_update() INSTEAD OF -= 
    ────────────────────────────────────────
    `_ws_clients -= dead` is an augmented assignment.  Python's compiler
    treats ANY assignment to a name inside a function — including +=, -=,
    etc. — as a declaration that the name is LOCAL to that function.  This
    means the earlier read `for ws in _ws_clients:` also looks for a local
    variable that was never initialised, causing:
        UnboundLocalError: cannot access local variable '_ws_clients'
                           where it is not associated with a value

    `.difference_update()` mutates the global set in-place without any
    assignment operator, so Python correctly resolves _ws_clients as the
    module-level global throughout the function.
    """
    dead: set[WebSocket] = set()
    payload = json.dumps(message)
    for ws in _ws_clients:
        try:
            await ws.send_text(payload)
        except Exception:
            dead.add(ws)
    _ws_clients.difference_update(dead)   # in-place removal — no assignment


async def candle_refresh_loop() -> None:
    """
    Refresh candle caches every 60 s; run SMC analysis after each refresh.

    Resilience design
    ─────────────────
    • Every fetch_candles call is capped at FETCH_TIMEOUT seconds.
    • Each instrument tracks consecutive failures. On failure the backoff
      sleep grows: 0 s → 5 s → 10 s → 20 s → 40 s (max), then resets on
      the next success so a recovered instrument is not permanently throttled.
    • The SMC analysis is wrapped in its own try/except so a strategy bug
      never kills the refresh loop.
    • The outer while-True has a final catch-all so any unexpected error
      restarts the loop after a short sleep instead of crashing the process.
    """
    FETCH_TIMEOUT   = 25.0           # seconds per individual candle request
    MAX_BACKOFF     = 40.0           # seconds max extra sleep per instrument
    fail_counts: dict[str, int] = {ins: 0 for ins in INSTRUMENTS}

    async def _fetch_with_timeout(ins: str, gran: str) -> list[Candle] | None:
        try:
            candles = await asyncio.wait_for(fetch_candles(ins, gran), timeout=FETCH_TIMEOUT)
            fail_counts[ins] = 0     # reset backoff on success
            return candles
        except asyncio.TimeoutError:
            logger.warning("Candle fetch TIMEOUT (%ss): %s %s", FETCH_TIMEOUT, ins, gran)
        except Exception as exc:
            logger.warning("Candle fetch ERROR %s %s: %s", ins, gran, exc)
        fail_counts[ins] = fail_counts.get(ins, 0) + 1
        return None

    while True:
        try:
            for ins in INSTRUMENTS:
                # ── Per-instrument exponential backoff ────────────────────
                fails   = fail_counts.get(ins, 0)
                backoff = min(5.0 * (2 ** max(0, fails - 1)), MAX_BACKOFF) if fails > 0 else 0.0
                if backoff:
                    logger.info("Backoff %.0fs for %s (consecutive failures: %d)", backoff, ins, fails)
                    await asyncio.sleep(backoff)

                # ── Refresh all granularities ─────────────────────────────
                for gran in GRANULARITIES:
                    result = await _fetch_with_timeout(ins, gran)
                    if result is not None:
                        _candle_cache[ins][gran] = result
                        logger.info("Refreshed %s %s (%d candles)", ins, gran, len(result))

                # ── SMC analysis on H1 ────────────────────────────────────
                try:
                    h1    = _candle_cache[ins]["H1"]
                    price = _latest_prices.get(ins)
                    if price and len(h1) >= 210:
                        signal: Optional[TradeSignal] = _engines[ins].analyze(
                            h1, price, int(time.time())
                        )
                        if signal:
                            sig_dict = {
                                "type":       "SIGNAL",
                                "instrument": signal.instrument,
                                "direction":  signal.direction.value,
                                "entry":      round(signal.entry_price, 5),
                                "sl":         round(signal.stop_loss, 5),
                                "tp":         round(signal.take_profit, 5),
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
                except Exception as smc_exc:
                    logger.warning("SMC analysis error for %s: %s", ins, smc_exc)

        except Exception as loop_exc:
            # Catch-all: an unexpected error in the loop must not crash the process.
            logger.error("candle_refresh_loop unexpected error: %s — restarting loop in 10s", loop_exc)
            await asyncio.sleep(10)
            continue

        await asyncio.sleep(60)


async def price_stream_loop() -> None:
    """Stream real-time ticks from Oanda and broadcast to WebSocket clients."""
    while True:
        # Skip entirely when credentials are absent — no point hammering Oanda
        if not _oanda_credentials_ok():
            logger.warning(
                "price_stream_loop: OANDA credentials missing — "
                "check OANDA_API_KEY and OANDA_ACCOUNT_ID in backend/.env. "
                "Retrying in 30 s."
            )
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
                                "type":       "TICK",
                                "instrument": ins,
                                "bid":        bid,
                                "ask":        ask,
                                "mid":        mid,
                                "time":       tick["time"],
                            })
        except Exception as exc:
            logger.error("Stream error: %s — reconnecting in 5s", exc)
            await asyncio.sleep(5)


# ─────────────────────────────────────────────────────────────────────────────
#  App lifecycle
# ─────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Startup: best-effort candle cache seed — Oanda outages must NOT crash the
    ASGI process.  Every seed request is capped at 20 s; failures are logged
    as warnings and the app starts with an empty cache for that feed (the
    candle_refresh_loop will fill it in on the next cycle).
    """
    # ── Credential pre-flight ─────────────────────────────────────────────────
    # Print a clear banner so the developer knows immediately whether the
    # credentials were loaded correctly.  This is the first thing to check
    # when seeing "Illegal header value b'Bearer '" errors.
    _key_live     = os.environ.get("OANDA_API_KEY",    "").strip()
    _account_live = os.environ.get("OANDA_ACCOUNT_ID", "").strip()
    logger.info("━" * 60)
    logger.info("  FX Radiant backend starting")
    logger.info("  OANDA_API_KEY   : %s", "✅ set" if _key_live     else "❌ MISSING — add to backend/.env")
    logger.info("  OANDA_ACCOUNT_ID: %s", "✅ set" if _account_live else "❌ MISSING — add to backend/.env")
    logger.info("  OANDA_BASE_URL  : %s", OANDA_BASE)
    if not _oanda_credentials_ok():
        logger.warning(
            "\n" + "━" * 60 + "\n"
            "  ⚠️  OANDA CREDENTIALS ARE MISSING\n"
            "  The app will start but ALL Oanda API calls will be skipped.\n"
            "\n"
            "  To fix:\n"
            "    1. Create the file:  fx-radiant/backend/.env\n"
            "    2. Add this line:    OANDA_API_KEY=your-64-char-key-here\n"
            "    3. Add this line:    OANDA_ACCOUNT_ID=your-account-id\n"
            "    4. Restart uvicorn\n"
            "\n"
            "  Your Oanda API key is at:\n"
            "    https://www.oanda.com/demo-account/tpa/personal_token\n"
            + "━" * 60
        )
    else:
        logger.info("━" * 60)

    # ── Best-effort candle cache seed ─────────────────────────────────────────
    async def _safe_seed(ins: str, gran: str):
        try:
            return ins, gran, await asyncio.wait_for(
                fetch_candles(ins, gran), timeout=20.0
            )
        except asyncio.TimeoutError:
            logger.warning("Seed timeout (20 s): %s %s — will retry in refresh loop", ins, gran)
        except Exception as exc:
            logger.warning("Seed error %s %s: %s — will retry in refresh loop", ins, gran, exc)
        return ins, gran, None   # None signals a failed seed

    seed_tasks = [_safe_seed(ins, gran) for ins in INSTRUMENTS for gran in GRANULARITIES]
    results    = await asyncio.gather(*seed_tasks)
    seeded, failed = 0, 0
    for ins, gran, candles in results:
        if candles is not None:
            _candle_cache[ins][gran] = candles
            seeded += 1
        else:
            failed += 1
    logger.info("✅ Candle seed complete — %d loaded, %d failed (will backfill)", seeded, failed)

    # Start background loops
    asyncio.create_task(price_stream_loop())
    asyncio.create_task(candle_refresh_loop())

    yield


# ─────────────────────────────────────────────────────────────────────────────
#  FastAPI App
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="FX Radiant API",
    version="1.0.0",
    description="SMC/ICT-powered forex trading backend",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    # ── Why allow_origins=["*"] works here ───────────────────────────────────
    # This app uses JWT Bearer tokens in the Authorization header — NOT cookies.
    # "Credentialed" CORS (allow_credentials=True) only applies to cookie /
    # HTTP-auth flows.  Bearer headers are just non-simple request headers that
    # go through a preflight.  Wildcard + credentials=False is therefore both
    # spec-compliant and sufficient.
    #
    # Mixing "*" + credentials=True is *illegal* per the CORS spec and causes
    # browsers to hard-block requests — that was the previous bug.
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Global 500 handler — always stamp CORS header ────────────────────────────
# When FastAPI raises an unhandled exception Starlette's CORSMiddleware never
# runs, so the browser sees "no CORS header" and reports a CORS error even
# though the real problem is a server crash.  This handler catches every
# unhandled Traceback and returns a JSON 500 that ALWAYS has the CORS header.
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

_EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')

class SignupRequest(BaseModel):
    email:    str        # validated by regex below — no email-validator dep needed
    password: str
    name:     str


class LoginResponse(BaseModel):
    access_token:  str
    refresh_token: str
    token_type:    str = "bearer"
    user:          dict


class RefreshRequest(BaseModel):
    refresh_token: str


class OrderRequest(BaseModel):
    instrument:  str
    units:       int
    stop_loss:   float
    take_profit: float


class UserSettingsRequest(BaseModel):
    """Payload for PATCH /api/users/me/settings"""
    auto_trade_enabled: Optional[bool] = None


# ─────────────────────────────────────────────────────────────────────────────
#  Auth routes
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/api/auth/signup", response_model=LoginResponse, status_code=201)
async def signup(body: SignupRequest):
    # Validate email format (replaces EmailStr — no extra package needed)
    if not _EMAIL_RE.match(body.email.strip()):
        raise HTTPException(422, "Invalid email address")
    email = body.email.strip().lower()
    if email in _users_db:
        raise HTTPException(400, "Email already registered")
    _users_db[email] = {
        "email":              email,
        "name":               body.name,
        "password":           hash_password(body.password),
        "auto_trade_enabled": False,
    }
    _save_users(_users_db)        # ← persist so user survives server restarts
    user_safe = {"email": email, "name": body.name}
    return LoginResponse(
        access_token=create_access_token(email),
        refresh_token=create_refresh_token(email),
        user=user_safe,
    )


@app.post("/api/auth/login", response_model=LoginResponse)
async def login(form: OAuth2PasswordRequestForm = Depends()):
    # Normalise to lowercase so "Trader@gmail.com" matches "trader@gmail.com"
    email = form.username.strip().lower()
    user = _users_db.get(email)
    if not user or not verify_password(form.password, user["password"]):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
    user_safe = {"email": user["email"], "name": user["name"]}
    return LoginResponse(
        access_token=create_access_token(email),
        refresh_token=create_refresh_token(email),
        user=user_safe,
    )


@app.post("/api/auth/refresh")
async def refresh_token(body: RefreshRequest):
    try:
        payload = jwt.decode(body.refresh_token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("type") != "refresh":
            raise HTTPException(401, "Invalid refresh token")
        email = payload["sub"]
    except JWTError:
        raise HTTPException(401, "Invalid refresh token")

    if email not in _users_db:
        raise HTTPException(401, "User not found")
    return {"access_token": create_access_token(email), "token_type": "bearer"}


@app.get("/api/auth/me")
async def me(user: dict = Depends(get_current_user)):
    return {
        "email":              user["email"],
        "name":               user["name"],
        "auto_trade_enabled": user.get("auto_trade_enabled", False),
    }


@app.patch("/api/users/me/settings")
async def update_user_settings(
    body: UserSettingsRequest,
    user: dict = Depends(get_current_user),
):
    """
    Update per-user trading preferences.
    Currently supports: auto_trade_enabled (bool).
    Mutates the in-memory user record directly — replace with a DB write
    when you add persistence.
    """
    if body.auto_trade_enabled is not None:
        user["auto_trade_enabled"] = body.auto_trade_enabled
        logger.info(
            "⚙️  auto_trade_enabled=%s  user=%s",
            body.auto_trade_enabled, user["email"],
        )
    return {
        "email":              user["email"],
        "auto_trade_enabled": user.get("auto_trade_enabled", False),
    }


# ─────────────────────────────────────────────────────────────────────────────
#  Market data routes
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/markets")
async def get_markets(_: dict = Depends(get_current_user)):
    result = []
    for ins in INSTRUMENTS:
        price = _latest_prices.get(ins, 0.0)
        h1 = _candle_cache[ins]["H1"]
        state = _engines[ins].get_partial_state(h1, price) if len(h1) >= 210 else None
        result.append({
            "instrument": ins,
            "price":      price,
            "confidence": state.confidence if state else 0,
            "bias":       state.layer1_bias.value if state else "NEUTRAL",
        })
    return result


@app.get("/api/markets/{instrument}/candles")
async def get_candles(
    instrument: str,
    granularity: str = "H1",
    _: dict = Depends(get_current_user),
):
    if instrument not in _candle_cache:
        raise HTTPException(404, "Instrument not found")
    candles = _candle_cache[instrument].get(granularity, [])
    return [
        {"t": c.time, "o": c.open, "h": c.high, "l": c.low, "c": c.close, "v": c.volume}
        for c in candles[-500:]
    ]


@app.get("/api/markets/{instrument}/analysis")
async def get_analysis(
    instrument: str,
    _: dict = Depends(get_current_user),
):
    if instrument not in _engines:
        raise HTTPException(404, "Instrument not found")
    price = _latest_prices.get(instrument, 0.0)
    h1 = _candle_cache[instrument]["H1"]
    state = _engines[instrument].get_partial_state(h1, price) if len(h1) >= 210 else None
    if not state:
        return {"confidence": 0}
    return {
        "instrument": instrument,
        "price":      price,
        "confidence": state.confidence,
        "layer1":     {"bias": state.layer1_bias.value, "active": state.layer1_bias.value != "NEUTRAL"},
        "layer2":     {"active": state.layer2_active, "zone": str(state.layer2_zone) if state.layer2_zone else None},
        "layer3":     {"mss": state.layer3_mss},
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
    """Return all currently open trades."""
    try:
        return await fetch_open_trades()
    except Exception as e:
        raise HTTPException(503, f"Oanda error: {e}")


@app.get("/api/account/history")
async def get_trade_history(_: dict = Depends(get_current_user)):
    """Return the 50 most recent closed trades."""
    try:
        return await fetch_trade_history(count=50)
    except Exception as e:
        raise HTTPException(503, f"Oanda error: {e}")


@app.post("/api/orders")
async def create_order(
    body: OrderRequest,
    _: dict = Depends(get_current_user),
):
    try:
        result = await place_market_order(
            body.instrument, body.units, body.stop_loss, body.take_profit
        )
        return result
    except Exception as e:
        raise HTTPException(503, f"Order error: {e}")


# ─────────────────────────────────────────────────────────────────────────────
#  WebSocket — real-time feed
# ─────────────────────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str = ""):
    # Validate JWT before accepting
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("type") != "access":
            await ws.close(code=4001)
            return
    except JWTError:
        await ws.close(code=4001)
        return

    await ws.accept()
    _ws_clients.add(ws)
    logger.info("WS client connected. Total: %d", len(_ws_clients))

    # Send initial snapshot — prices + last 5 signals per instrument
    snapshot = {
        "type":    "SNAPSHOT",
        "prices":  _latest_prices,
        "signals": {ins: _signal_history[ins][:5] for ins in INSTRUMENTS},
    }
    await ws.send_text(json.dumps(snapshot))

    try:
        while True:
            raw = await ws.receive_text()

            # Parse client messages — anything that isn't valid JSON (e.g. the
            # keep-alive "ping" string) is silently ignored.
            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue

            msg_type = msg.get("type")

            # ── SUBSCRIBE ─────────────────────────────────────────────────────
            # When the frontend selects an instrument it sends:
            #   { "type": "SUBSCRIBE", "instrument": "EUR_USD" }
            #
            # We respond immediately with a synthetic TICK carrying the cached
            # price so the detail drawer updates at once rather than waiting up
            # to several seconds for the next real Oanda tick.
            if msg_type == "SUBSCRIBE":
                ins = msg.get("instrument", "")
                if ins in INSTRUMENTS:
                    cached_price = _latest_prices.get(ins)
                    if cached_price is not None:
                        await ws.send_text(json.dumps({
                            "type":       "TICK",
                            "instrument": ins,
                            "bid":        cached_price,
                            "ask":        cached_price,
                            "mid":        cached_price,
                            "time":       str(int(time.time())),
                        }))
                    # Also push the latest signal history for this instrument
                    signals = _signal_history.get(ins, [])
                    if signals:
                        await ws.send_text(json.dumps({
                            "type":    "SIGNAL_HISTORY",
                            "instrument": ins,
                            "signals": signals[:5],
                        }))

    except WebSocketDisconnect:
        _ws_clients.discard(ws)
        logger.info("WS client disconnected. Total: %d", len(_ws_clients))


# ─────────────────────────────────────────────────────────────────────────────
#  Health
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status":        "ok",
        "ws_clients":    len(_ws_clients),
        "cached_prices": len(_latest_prices),
        "timestamp":     int(time.time()),
    }