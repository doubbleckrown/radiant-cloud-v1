"""
FX Radiant — FastAPI Backend  v2.3
===================================
• Clerk JWT Authentication (RS256 JWKS — no manual login)
• Oanda v20 WebSocket price streaming + candle polling
• Bybit V5 Linear (Perpetuals) candle polling + ticker refresh  (crypto engine)
• SMC Confluence Engine — fires signals at 100 % confluence
• Dynamic SL / Breakeven risk engine
• Multi-user: per-user credentials stored in Supabase

Engine design:
  OANDA  — ema_period=200, rr_ratio=2.0, H1  primary timeframe
  BYBIT  — ema_period=50,  rr_ratio=3.0, H1  primary timeframe
  (Bybit kline capped at 200 per request; 50-EMA gives meaningful signals.
   rr_ratio=3.0 matches the 1:3 RR product spec.)
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import time
import urllib.parse
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

# ── Load .env BEFORE any os.getenv() ──────────────────────────────────────────
try:
    from dotenv import load_dotenv
    _env_path = Path(__file__).resolve().parent.parent / ".env"
    _loaded   = load_dotenv(_env_path, override=False)
    print(f"[fx-radiant] {'✅' if _loaded else '⚠️ '} .env {'loaded' if _loaded else 'not found'}: {_env_path}",
          flush=True)
except ImportError:
    print("[fx-radiant] ⚠️  python-dotenv not installed", flush=True)

import httpx
import jwt as _jwt
from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.services.strategy import Candle, SMCConfluenceEngine, TradeSignal


# ─────────────────────────────────────────────────────────────────────────────
#  Config — Oanda
# ─────────────────────────────────────────────────────────────────────────────

OANDA_API_KEY  = os.getenv("OANDA_API_KEY",   "")
OANDA_ACCOUNT  = os.getenv("OANDA_ACCOUNT_ID", "")
OANDA_BASE     = os.getenv("OANDA_BASE_URL",   "https://api-fxpractice.oanda.com")
OANDA_STREAM   = os.getenv("OANDA_STREAM_URL", "https://stream-fxpractice.oanda.com")

CLERK_JWKS_URL = os.getenv(
    "CLERK_JWKS_URL",
    "https://immune-donkey-10.clerk.accounts.dev/.well-known/jwks.json",
)

ONESIGNAL_APP_ID   = os.getenv("ONESIGNAL_APP_ID",  "")
ONESIGNAL_REST_KEY = os.getenv("ONESIGNAL_REST_KEY", "")

SUPABASE_URL              = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

# ─────────────────────────────────────────────────────────────────────────────
#  Config — Bybit V5 Linear (Perpetuals)
# ─────────────────────────────────────────────────────────────────────────────

BYBIT_BASE = "https://api.bybit.com"

# Optional global read-only Bybit credentials.
# Public market endpoints (kline, tickers) need NO key.
# These env vars are only used as fallback for account endpoints when a user
# hasn't saved personal credentials in their Profile.
BYBIT_READ_ONLY_KEY    = os.getenv("BYBIT_READ_ONLY_KEY",    "")
BYBIT_READ_ONLY_SECRET = os.getenv("BYBIT_READ_ONLY_SECRET", "")

# Default leverage for Bybit auto-execution
BYBIT_DEFAULT_LEVERAGE = int(os.getenv("BYBIT_DEFAULT_LEVERAGE", "20"))

# 15 high-volume Bybit Linear (USDT perpetual) symbols
BYBIT_SYMBOLS = [
    "BTCUSDT",  "ETHUSDT",  "SOLUSDT",  "XRPUSDT",  "BNBUSDT",
    "DOGEUSDT", "AVAXUSDT", "ADAUSDT",  "DOTUSDT",  "MATICUSDT",
    "LINKUSDT", "LTCUSDT",  "NEARUSDT", "ATOMUSDT", "UNIUSDT",
]

# Bybit V5 interval strings: "60"=H1, "15"=M15, "5"=M5, "1"=M1
BYBIT_INTERVALS = ["60", "15", "5", "1"]

# ─────────────────────────────────────────────────────────────────────────────
#  Oanda instruments + granularities
# ─────────────────────────────────────────────────────────────────────────────

INSTRUMENTS = [
    # Forex majors
    "EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD",
    "NZD_USD", "USD_CAD", "USD_CHF",
    # Metals
    "XAU_USD",
    # Indices  (corrected symbols — GER30_EUR/J225_USD/BTC_USD are NOT valid on Oanda v20)
    "NAS100_USD", "US30_USD", "SPX500_USD",
    "DE30_EUR",   "UK100_GBP", "JP225_USD",
    # HK33_HKD removed — practice accounts typically reject it
]
GRANULARITIES = ["M1", "M5", "M15", "H1"]

logger = logging.getLogger("fx-radiant")
logging.basicConfig(level=logging.INFO)


# ─────────────────────────────────────────────────────────────────────────────
#  In-memory stores — Oanda
# ─────────────────────────────────────────────────────────────────────────────

_clerk_jwks:    dict[str, Any]  = {}
_user_settings: dict[str, dict] = {}

def _settings(clerk_id: str) -> dict:
    return _user_settings.setdefault(clerk_id, {
        # Oanda
        "auto_trade_enabled":  False,
        "risk_pct":            1.0,
        "oanda_key_hint":      "",
        "oanda_account_id":    "",
        # Bybit
        "bybit_key_hint":      "",
        "bybit_secret_hint":   "",
        "bybit_auto_trade":    False,      # Bybit-specific auto-execution toggle
        "bybit_leverage":      20,         # 10–50×, default 20×
        "bybit_margin_type":   "ISOLATED", # "ISOLATED" | "CROSS"
    })

_candle_cache:   dict[str, dict[str, list[Candle]]] = {
    ins: {gran: [] for gran in GRANULARITIES} for ins in INSTRUMENTS
}
_latest_prices:  dict[str, float]       = {}
_ws_clients:     set[WebSocket]         = set()
_signal_history: dict[str, list[dict]]  = {ins: [] for ins in INSTRUMENTS}
_engines:        dict[str, SMCConfluenceEngine] = {
    ins: SMCConfluenceEngine(ins) for ins in INSTRUMENTS
}
_push_subscriptions: set[str] = set()


# ─────────────────────────────────────────────────────────────────────────────
#  In-memory stores — Bybit
# ─────────────────────────────────────────────────────────────────────────────

_bybit_candle_cache:   dict[str, dict[str, list[Candle]]] = {
    sym: {iv: [] for iv in BYBIT_INTERVALS} for sym in BYBIT_SYMBOLS
}
_bybit_prices:         dict[str, float] = {}   # latest mark price
_bybit_meta:           dict[str, dict]  = {}   # 24 h stats per symbol
_bybit_signal_history: dict[str, list[dict]] = {sym: [] for sym in BYBIT_SYMBOLS}

# ema_period=50  — fires meaningful signals on the ≤1000 candle window
# rr_ratio=3.0   — 1:3 risk-reward per product spec
_bybit_engines: dict[str, SMCConfluenceEngine] = {
    sym: SMCConfluenceEngine(sym, ema_period=50, rr_ratio=3.0)
    for sym in BYBIT_SYMBOLS
}

# ─────────────────────────────────────────────────────────────────────────────
#  TradeTracker — Signal Deduplication & Trade Lock
#
#  Rules:
#    1. When a trade is placed for a symbol, that symbol is LOCKED.
#    2. The lock expires automatically after TRADE_LOCK_TTL_SECONDS (2 hours).
#    3. Locking is set both on auto-execution AND on signal generation — so
#       even if auto-trade is OFF, we suppress duplicate UI signals.
#    4. A locked symbol's signals are NOT added to _bybit_signal_history.
#    5. When the lock expires the engine resets and looks for a fresh setup.
# ─────────────────────────────────────────────────────────────────────────────

TRADE_LOCK_TTL_SECONDS = 7200  # 2 hours

class TradeTracker:
    """In-memory trade lock registry.  Thread-safe via asyncio single-thread model."""

    def __init__(self) -> None:
        # symbol → {direction, entry, expires_at, trade_id}
        self._locks: dict[str, dict] = {}

    def is_locked(self, symbol: str) -> bool:
        lock = self._locks.get(symbol)
        if not lock:
            return False
        if time.time() > lock["expires_at"]:
            del self._locks[symbol]
            logger.info("TradeTracker: lock EXPIRED for %s", symbol)
            return False
        return True

    def lock(self, symbol: str, direction: str, entry: float, trade_id: str = "") -> None:
        self._locks[symbol] = {
            "direction":  direction,
            "entry":      entry,
            "trade_id":   trade_id,
            "locked_at":  time.time(),
            "expires_at": time.time() + TRADE_LOCK_TTL_SECONDS,
        }
        logger.info(
            "TradeTracker: LOCKED %s %s @ %.5f  (expires in 2h)",
            symbol, direction, entry,
        )

    def unlock(self, symbol: str) -> None:
        if symbol in self._locks:
            del self._locks[symbol]
            logger.info("TradeTracker: UNLOCKED %s", symbol)

    def get_lock(self, symbol: str) -> dict | None:
        if not self.is_locked(symbol):
            return None
        return self._locks.get(symbol)

    def all_locks(self) -> dict[str, dict]:
        """Return snapshot of active locks (pruning expired ones first)."""
        stale = [s for s, l in self._locks.items() if time.time() > l["expires_at"]]
        for s in stale:
            del self._locks[s]
        return dict(self._locks)


# Global TradeTracker instance — shared by the refresh loop and API routes
_trade_tracker = TradeTracker()


# ─────────────────────────────────────────────────────────────────────────────
#  Clerk JWT helpers
# ─────────────────────────────────────────────────────────────────────────────

async def _fetch_clerk_jwks() -> None:
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
        logger.error("Could not load Clerk JWKS: %s", exc)


async def _verify_clerk_token(raw_token: str) -> dict:
    if not raw_token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing token")
    try:
        header = _jwt.get_unverified_header(raw_token)
        kid    = header.get("kid")
        pub    = _clerk_jwks.get(kid)
        if pub is None:
            await _fetch_clerk_jwks()
            pub = _clerk_jwks.get(kid)
        if pub is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unknown signing key")
        payload = _jwt.decode(
            raw_token, pub, algorithms=["RS256"],
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
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing Authorization header")
    return await _verify_clerk_token(auth.split(" ", 1)[1].strip())


# ─────────────────────────────────────────────────────────────────────────────
#  Oanda v20 helpers
# ─────────────────────────────────────────────────────────────────────────────

def _oanda_credentials_ok() -> bool:
    return bool(
        os.environ.get("OANDA_API_KEY",    "").strip()
        and os.environ.get("OANDA_ACCOUNT_ID", "").strip()
    )

def _oanda_headers() -> dict:
    key = os.environ.get("OANDA_API_KEY", "").strip()
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}

def _oanda_headers_for(api_key: str) -> dict:
    return {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}


async def _get_user_oanda_creds(clerk_id: str) -> tuple[str, str] | None:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        key     = os.environ.get("OANDA_API_KEY",    "").strip()
        account = os.environ.get("OANDA_ACCOUNT_ID", "").strip()
        return (key, account) if (key and account) else None
    try:
        url     = f"{SUPABASE_URL}/rest/v1/users"
        headers = {
            "apikey":        SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type":  "application/json",
        }
        params = {"clerk_id": f"eq.{clerk_id}", "select": "oanda_api_key,oanda_account_id"}
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.get(url, headers=headers, params=params)
            resp.raise_for_status()
        rows = resp.json()
        if rows and rows[0].get("oanda_api_key") and rows[0].get("oanda_account_id"):
            return rows[0]["oanda_api_key"], rows[0]["oanda_account_id"]
        key     = os.environ.get("OANDA_API_KEY",    "").strip()
        account = os.environ.get("OANDA_ACCOUNT_ID", "").strip()
        return (key, account) if (key and account) else None
    except Exception as exc:
        logger.warning("Supabase Oanda cred lookup: %s", exc)
        key     = os.environ.get("OANDA_API_KEY",    "").strip()
        account = os.environ.get("OANDA_ACCOUNT_ID", "").strip()
        return (key, account) if (key and account) else None


async def _upsert_user_oanda_creds(clerk_id: str, api_key: str, account_id: str) -> None:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        logger.warning("Supabase not configured — Oanda credentials not persisted")
        return
    url     = f"{SUPABASE_URL}/rest/v1/users"
    headers = {
        "apikey":        SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates",
    }
    payload = {"clerk_id": clerk_id, "oanda_api_key": api_key, "oanda_account_id": account_id}
    async with httpx.AsyncClient(timeout=8) as client:
        resp = await client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
    logger.info("Supabase: Oanda creds saved clerk_id=%s…", clerk_id[:8])


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


async def fetch_account_summary(api_key: str, account_id: str) -> dict:
    url = f"{OANDA_BASE}/v3/accounts/{account_id}/summary"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url, headers=_oanda_headers_for(api_key))
        resp.raise_for_status()
    return resp.json().get("account", {})


async def fetch_open_trades(api_key: str, account_id: str) -> list:
    url = f"{OANDA_BASE}/v3/accounts/{account_id}/openTrades"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url, headers=_oanda_headers_for(api_key))
        resp.raise_for_status()
    return resp.json().get("trades", [])


async def fetch_trade_history(api_key: str, account_id: str, count: int = 50) -> list:
    url    = f"{OANDA_BASE}/v3/accounts/{account_id}/trades"
    params = {"state": "CLOSED", "count": str(count)}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url, headers=_oanda_headers_for(api_key), params=params)
        resp.raise_for_status()
    return resp.json().get("trades", [])


async def place_market_order(
    api_key: str, account_id: str,
    instrument: str, units: int, stop_loss: float, take_profit: float,
) -> dict:
    url  = f"{OANDA_BASE}/v3/accounts/{account_id}/orders"
    body = {"order": {
        "type": "MARKET", "instrument": instrument, "units": str(units),
        "stopLossOnFill":   {"price": f"{stop_loss:.5f}"},
        "takeProfitOnFill": {"price": f"{take_profit:.5f}"},
        "timeInForce": "FOK",
    }}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, headers=_oanda_headers_for(api_key), json=body)
        resp.raise_for_status()
    return resp.json()


# ─────────────────────────────────────────────────────────────────────────────
#  Bybit — Supabase credential helpers
#
#  Identical resolution chain to the Oanda helpers:
#    1. Personal key in Supabase for this clerk_id
#    2. BYBIT_READ_ONLY_KEY / BYBIT_READ_ONLY_SECRET from .env
#    3. None → caller returns HTTP 422
#
#  Note: kline + tickers are fully public — callers that only need
#  market data must NOT call this (they use the unauthenticated endpoints).
# ─────────────────────────────────────────────────────────────────────────────

async def _get_user_bybit_creds(clerk_id: str) -> tuple[str, str] | None:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        if BYBIT_READ_ONLY_KEY and BYBIT_READ_ONLY_SECRET:
            return BYBIT_READ_ONLY_KEY, BYBIT_READ_ONLY_SECRET
        return None
    try:
        url     = f"{SUPABASE_URL}/rest/v1/users"
        headers = {
            "apikey":        SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type":  "application/json",
        }
        params = {
            "clerk_id": f"eq.{clerk_id}",
            "select":   "bybit_api_key,bybit_api_secret",
        }
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.get(url, headers=headers, params=params)
            resp.raise_for_status()
        rows = resp.json()
        if rows and rows[0].get("bybit_api_key") and rows[0].get("bybit_api_secret"):
            return rows[0]["bybit_api_key"], rows[0]["bybit_api_secret"]
        if BYBIT_READ_ONLY_KEY and BYBIT_READ_ONLY_SECRET:
            return BYBIT_READ_ONLY_KEY, BYBIT_READ_ONLY_SECRET
        return None
    except Exception as exc:
        logger.warning("Supabase Bybit cred lookup: %s", exc)
        if BYBIT_READ_ONLY_KEY and BYBIT_READ_ONLY_SECRET:
            return BYBIT_READ_ONLY_KEY, BYBIT_READ_ONLY_SECRET
        return None


async def _upsert_user_bybit_creds(
    clerk_id: str, api_key: str, api_secret: str,
) -> None:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        logger.warning("Supabase not configured — Bybit credentials not persisted")
        return
    url     = f"{SUPABASE_URL}/rest/v1/users"
    headers = {
        "apikey":        SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates",
    }
    payload = {
        "clerk_id":        clerk_id,
        "bybit_api_key":   api_key,
        "bybit_api_secret": api_secret,
    }
    async with httpx.AsyncClient(timeout=8) as client:
        resp = await client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
    logger.info("Supabase: Bybit creds saved clerk_id=%s…", clerk_id[:8])


# ─────────────────────────────────────────────────────────────────────────────
#  Bybit V5 — HMAC-SHA256 authentication
#
#  Bybit V5 signed endpoint pattern:
#    signature = HMAC-SHA256(api_secret, timestamp + api_key + recvWindow + rawParams)
#
#  For GET requests: rawParams = URL query string (sorted, URL-encoded)
#  For POST requests: rawParams = JSON body string
#
#  Headers:
#    X-BAPI-API-KEY, X-BAPI-SIGN, X-BAPI-SIGN-ALGORITHM, X-BAPI-TIMESTAMP,
#    X-BAPI-RECV-WINDOW
# ─────────────────────────────────────────────────────────────────────────────

def _bybit_sign_get(api_key: str, api_secret: str, params: dict) -> tuple[dict, dict]:
    """Sign a GET request. Returns (params, headers)."""
    timestamp   = str(int(time.time() * 1000))
    recv_window = "5000"
    query_str   = urllib.parse.urlencode(sorted(params.items()))
    param_str   = timestamp + api_key + recv_window + query_str
    signature   = hmac.new(
        api_secret.encode("utf-8"),
        param_str.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    headers = {
        "X-BAPI-API-KEY":           api_key,
        "X-BAPI-SIGN":              signature,
        "X-BAPI-SIGN-ALGORITHM":    "HmacSHA256",
        "X-BAPI-TIMESTAMP":         timestamp,
        "X-BAPI-RECV-WINDOW":       recv_window,
        "Content-Type":             "application/json",
    }
    return params, headers


def _bybit_sign_post(api_key: str, api_secret: str, body: dict) -> tuple[dict, dict]:
    """Sign a POST request. Returns (body, headers)."""
    import json as _json
    timestamp   = str(int(time.time() * 1000))
    recv_window = "5000"
    body_str    = _json.dumps(body, separators=(",", ":"))
    param_str   = timestamp + api_key + recv_window + body_str
    signature   = hmac.new(
        api_secret.encode("utf-8"),
        param_str.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    headers = {
        "X-BAPI-API-KEY":        api_key,
        "X-BAPI-SIGN":           signature,
        "X-BAPI-SIGN-ALGORITHM": "HmacSHA256",
        "X-BAPI-TIMESTAMP":      timestamp,
        "X-BAPI-RECV-WINDOW":    recv_window,
        "Content-Type":          "application/json",
    }
    return body, headers


# ─────────────────────────────────────────────────────────────────────────────
#  Bybit V5 — public market data helpers (no credentials required)
#
#  Bybit kline + tickers are fully public — no API key needed.
#  Used by both the refresh loop and the candles/market routes.
# ─────────────────────────────────────────────────────────────────────────────

async def bybit_fetch_candles(
    symbol:   str,
    interval: str,   # "60"=H1, "15"=M15, "5"=M5, "1"=M1
    limit:    int = 200,
) -> list[Candle]:
    """
    Fetch up to `limit` completed candles from Bybit V5 Linear kline endpoint.

    Bybit returns candles NEWEST-FIRST — we reverse to oldest-first for the
    SMC engine so index 0 is the oldest candle.

    Row format (list[0]):
        0: startTime (ms)
        1: openPrice
        2: highPrice
        3: lowPrice
        4: closePrice
        5: volume (base asset, e.g. BTC)
        6: turnover (USDT)

    The first row (index 0 in Bybit's response) is the still-forming current
    candle — we drop it so only complete candles are fed to the SMC engine.
    """
    params = {
        "category": "linear",
        "symbol":   symbol,
        "interval": interval,
        "limit":    str(min(limit, 200)),
    }
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(f"{BYBIT_BASE}/v5/market/kline", params=params)
        resp.raise_for_status()

    data = resp.json()
    if data.get("retCode", -1) != 0:
        raise RuntimeError(f"Bybit kline error {data.get('retCode')}: {data.get('retMsg')}")

    rows = data.get("result", {}).get("list", [])
    if not isinstance(rows, list):
        raise RuntimeError(f"Bybit kline unexpected format: {str(rows)[:200]}")

    candles = [
        Candle(
            time   = int(row[0]) // 1000,  # ms → seconds
            open   = float(row[1]),
            high   = float(row[2]),
            low    = float(row[3]),
            close  = float(row[4]),
            volume = float(row[5]),
        )
        for row in rows
        if len(row) >= 6
    ]
    # Bybit returns newest-first — reverse to oldest-first, drop forming candle
    candles.reverse()
    return candles[:-1] if candles else candles


async def bybit_fetch_tickers(symbols: list[str]) -> dict[str, dict]:
    """
    Fetch 24 h ticker stats for all Bybit Linear symbols in one request,
    filtered to the requested symbol set.

    Returns dict keyed by symbol:
        price      — latest mark price
        high24h    — 24 h high
        low24h     — 24 h low
        volume24h  — 24 h turnover in USDT
        change24h  — 24 h price change percent (float, e.g. 1.23)
    """
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"{BYBIT_BASE}/v5/market/tickers",
            params={"category": "linear"},
        )
        resp.raise_for_status()

    data = resp.json()
    if data.get("retCode", -1) != 0:
        raise RuntimeError(f"Bybit tickers error {data.get('retCode')}: {data.get('retMsg')}")

    items  = data.get("result", {}).get("list", [])
    sym_set = set(symbols)
    result: dict[str, dict] = {}

    for item in items:
        sym = item.get("symbol", "")
        if sym not in sym_set:
            continue
        try:
            result[sym] = {
                "price":    float(item.get("lastPrice",       0) or 0),
                "high24h":  float(item.get("highPrice24h",    0) or 0),
                "low24h":   float(item.get("lowPrice24h",     0) or 0),
                # turnover24h is USDT-denominated
                "volume24h": float(item.get("turnover24h",   0) or 0),
                # price24hPcnt is a decimal like "0.0123" → convert to percent
                "change24h": round(float(item.get("price24hPcnt", 0) or 0) * 100, 2),
            }
        except (ValueError, TypeError):
            pass
    return result


# ─────────────────────────────────────────────────────────────────────────────
#  Bybit V5 — private account helpers (HMAC auth required)
# ─────────────────────────────────────────────────────────────────────────────

async def bybit_fetch_account(api_key: str, api_secret: str) -> dict:
    """
    Fetch Bybit Unified Trading Account balance.

    Normalized response:
        accountType      — "UNIFIED"
        totalEquity      — total equity in USDT
        totalAvailable   — available balance
        totalMargin      — margin in use
        coin             — list of non-zero coin balances
        totalUSDT        — convenience alias for totalEquity
    """
    params, headers = _bybit_sign_get(api_key, api_secret, {"accountType": "UNIFIED"})

    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(
            f"{BYBIT_BASE}/v5/account/wallet-balance",
            headers=headers, params=params,
        )
        resp.raise_for_status()

    data = resp.json()
    if data.get("retCode", -1) != 0:
        raise RuntimeError(f"Bybit account error {data.get('retCode')}: {data.get('retMsg')}")

    account = (data.get("result", {}).get("list") or [{}])[0]

    total_equity    = float(account.get("totalEquity",           0) or 0)
    total_available = float(account.get("totalAvailableBalance", 0) or 0)
    total_margin    = float(account.get("totalMarginBalance",    0) or 0)

    # Filter to non-zero coin balances
    coins = [
        c for c in account.get("coin", [])
        if float(c.get("walletBalance", 0) or 0) > 0
    ]

    return {
        "accountType":           account.get("accountType", "UNIFIED"),
        "totalEquity":           round(total_equity,    2),
        "totalMarginBalance":    round(total_margin,    2),   # alias for frontend compatibility
        "totalAvailableBalance": round(total_available, 2),   # alias for frontend compatibility
        "totalAvailable":        round(total_available, 2),
        "totalMargin":           round(total_margin,    2),
        "totalUSDT":             round(total_equity,    2),   # convenience alias
        "coin":                  coins,
    }


async def bybit_fetch_positions(api_key: str, api_secret: str) -> list:
    """
    Fetch open Linear (USDT perpetual) positions for this account.
    Returns [] when no positions are open.
    """
    params, headers = _bybit_sign_get(api_key, api_secret, {
        "category":   "linear",
        "settleCoin": "USDT",
        "limit":      "50",
    })

    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(
            f"{BYBIT_BASE}/v5/position/list",
            headers=headers, params=params,
        )
        resp.raise_for_status()

    data = resp.json()
    if data.get("retCode", -1) != 0:
        raise RuntimeError(f"Bybit positions error {data.get('retCode')}: {data.get('retMsg')}")

    positions = data.get("result", {}).get("list", [])
    # Only return positions with non-zero size
    return [p for p in positions if float(p.get("size", 0) or 0) > 0]


async def bybit_fetch_trade_history(
    api_key: str, api_secret: str, limit: int = 50,
) -> list:
    """
    Fetch recent execution history for Linear category.
    """
    params, headers = _bybit_sign_get(api_key, api_secret, {
        "category": "linear",
        "limit":    str(min(limit, 100)),
    })

    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(
            f"{BYBIT_BASE}/v5/execution/list",
            headers=headers, params=params,
        )
        resp.raise_for_status()

    data = resp.json()
    if data.get("retCode", -1) != 0:
        raise RuntimeError(f"Bybit history error {data.get('retCode')}: {data.get('retMsg')}")

    trades = data.get("result", {}).get("list", [])
    trades.sort(key=lambda t: int(t.get("execTime", 0)), reverse=True)
    return trades


async def bybit_set_margin_mode(
    api_key: str, api_secret: str, symbol: str, margin_type: str = "ISOLATED",
) -> None:
    """
    Set margin mode for a symbol to ISOLATED or CROSS.
    retCode 110043 = already in that mode (not an error).
    """
    body = {
        "category":   "linear",
        "symbol":     symbol,
        "tradeMode":  1 if margin_type == "ISOLATED" else 0,
        "buyLeverage":  str(BYBIT_DEFAULT_LEVERAGE),
        "sellLeverage": str(BYBIT_DEFAULT_LEVERAGE),
    }
    _, headers = _bybit_sign_post(api_key, api_secret, body)
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{BYBIT_BASE}/v5/position/switch-isolated",
                headers=headers, json=body,
            )
        data = resp.json()
        if data.get("retCode", -1) not in (0, 110043):
            logger.warning("Bybit set-margin-mode %s: code=%s msg=%s",
                           symbol, data.get("retCode"), data.get("retMsg"))
    except Exception as exc:
        logger.warning("Bybit set-margin-mode %s: %s", symbol, exc)


async def bybit_set_leverage(
    api_key: str, api_secret: str, symbol: str, leverage: int,
    margin_type: str = "ISOLATED",
) -> None:
    """Set leverage (and margin mode) for a symbol before placing an order."""
    # Set margin mode first — must be done before changing leverage
    await bybit_set_margin_mode(api_key, api_secret, symbol, margin_type)

    body = {
        "category":     "linear",
        "symbol":       symbol,
        "buyLeverage":  str(leverage),
        "sellLeverage": str(leverage),
    }
    _, headers = _bybit_sign_post(api_key, api_secret, body)

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"{BYBIT_BASE}/v5/position/set-leverage",
            headers=headers, json=body,
        )
    data = resp.json()
    if data.get("retCode", -1) not in (0, 110043):  # 110043 = leverage unchanged
        logger.warning("Bybit set-leverage %s: code=%s msg=%s",
                       symbol, data.get("retCode"), data.get("retMsg"))


async def bybit_place_market_order(
    api_key:     str,
    api_secret:  str,
    symbol:      str,
    side:        str,        # "Buy" | "Sell"
    qty:         str,        # base asset quantity as string, e.g. "0.001"
    stop_loss:   float,
    take_profit: float,
    leverage:    int  = BYBIT_DEFAULT_LEVERAGE,
    margin_type: str  = "ISOLATED",
) -> dict:
    """
    Place a Bybit Linear perpetual market order with SL + TP.
    Sets margin mode + leverage first, then submits the order.
    Default: 20x Isolated Margin (per product spec).
    """
    await bybit_set_leverage(api_key, api_secret, symbol, leverage, margin_type)

    body = {
        "category":    "linear",
        "symbol":      symbol,
        "side":        side,
        "orderType":   "Market",
        "qty":         qty,
        "stopLoss":    f"{stop_loss:.4f}",
        "takeProfit":  f"{take_profit:.4f}",
        "timeInForce": "IOC",
        "positionIdx": 0,   # 0 = one-way mode
    }
    _, headers = _bybit_sign_post(api_key, api_secret, body)

    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(
            f"{BYBIT_BASE}/v5/order/create",
            headers=headers, json=body,
        )
        resp.raise_for_status()

    data = resp.json()
    if data.get("retCode", -1) != 0:
        raise RuntimeError(f"Bybit order error {data.get('retCode')}: {data.get('retMsg')}")

    logger.info("✅ Bybit order placed: %s %s %s  qty=%s", symbol, side, "Market", qty)
    return data


async def bybit_verify_credentials(api_key: str, api_secret: str) -> bool:
    """Verify credentials by fetching account info. Raises RuntimeError on failure."""
    await bybit_fetch_account(api_key, api_secret)
    return True


# ─────────────────────────────────────────────────────────────────────────────
#  Bybit V5 — background refresh loop
#
#  Every 60 s:
#    1. Refresh tickers for all 15 symbols (single public request)
#    2. Refresh H1 + M15 + M5 + M1 candles per symbol
#    3. Run SMC analysis on H1 candles; emit signals at 100% confluence
#
#  Key Bybit differences from Oanda:
#    • Bybit candles are newest-first in API response — bybit_fetch_candles()
#      reverses to oldest-first for the SMC engine.
#    • Maximum 200 candles per Bybit request (use limit=200).
#    • Minimum 60 H1 candles gate for the 50-EMA to be valid.
# ─────────────────────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────────────────
#  _bybit_auto_execute — fires a market order for every user who has
#  bybit_auto_trade=True AND has valid Bybit credentials in Supabase.
#
#  Safety guards:
#    • Instrument must NOT already be locked by TradeTracker
#    • Minimum qty check: Bybit requires qty ≥ minOrderQty (0.001 for BTCUSDT)
#    • Leverage auto-scale: if SL distance × leverage > 80% of position value,
#      reduce leverage until within safe margin
# ─────────────────────────────────────────────────────────────────────────────

_MIN_ORDER_QTY: dict[str, float] = {
    "BTCUSDT": 0.001, "ETHUSDT": 0.01, "SOLUSDT": 0.1, "XRPUSDT": 10.0,
    "BNBUSDT": 0.01, "DOGEUSDT": 100.0, "AVAXUSDT": 0.1, "ADAUSDT": 10.0,
    "DOTUSDT": 1.0, "MATICUSDT": 10.0, "LINKUSDT": 1.0, "LTCUSDT": 0.1,
    "NEARUSDT": 1.0, "ATOMUSDT": 1.0, "UNIUSDT": 1.0,
}

def _compute_safe_leverage(
    entry: float, sl: float, leverage: int, margin_usd: float = 100.0,
) -> int:
    """
    Auto-scale leverage down if sl_distance × leverage > 80% of margin.
    Returns the adjusted leverage (minimum 1×).
    """
    sl_distance = abs(entry - sl)
    if sl_distance <= 0 or entry <= 0:
        return leverage
    # Risk per unit at full leverage
    risk_ratio = (sl_distance / entry) * leverage
    while risk_ratio > 0.8 and leverage > 1:
        leverage -= 1
        risk_ratio = (sl_distance / entry) * leverage
    return leverage


async def _bybit_auto_execute(
    sym: str, sig_dict: dict, signal: "TradeSignal",
) -> None:
    """
    Called when a 100% confluence Bybit signal fires.
    Iterates over all users with bybit_auto_trade=True and places orders.
    """
    if _trade_tracker.is_locked(sym):
        logger.info("AutoExec: %s already locked — skip", sym)
        return

    for clerk_id, prefs in list(_user_settings.items()):
        if not prefs.get("bybit_auto_trade"):
            continue

        leverage    = int(prefs.get("bybit_leverage",    BYBIT_DEFAULT_LEVERAGE))
        margin_type = str(prefs.get("bybit_margin_type", "ISOLATED"))

        creds = await _get_user_bybit_creds(clerk_id)
        if not creds:
            logger.warning("AutoExec: no Bybit creds for %s… — skip", clerk_id[:8])
            continue

        api_key, api_secret = creds

        # Fetch account equity to size position at 1% risk
        try:
            account_data = await bybit_fetch_account(api_key, api_secret)
            equity       = float(account_data.get("totalEquity", 0) or 0)
        except Exception as exc:
            logger.warning("AutoExec: account fetch failed for %s…: %s", clerk_id[:8], exc)
            continue

        if equity <= 0:
            logger.warning("AutoExec: zero equity for %s… — skip", clerk_id[:8])
            continue

        risk_pct   = float(prefs.get("risk_pct", 1.0)) / 100.0
        risk_usd   = equity * risk_pct
        entry      = signal.entry_price
        sl         = signal.stop_loss
        tp         = signal.take_profit
        sl_dist    = abs(entry - sl)

        if sl_dist <= 0:
            logger.warning("AutoExec: zero SL distance for %s — skip", sym)
            continue

        # Auto-scale leverage to keep risk ≤ 80% of margin
        safe_lev = _compute_safe_leverage(entry, sl, leverage)
        if safe_lev != leverage:
            logger.info(
                "AutoExec: leverage scaled %d→%d× for %s (SL distance safety)",
                leverage, safe_lev, sym,
            )

        # qty = risk_usd / (sl_dist_per_unit × leverage)
        # This means losing the SL distance costs exactly risk_usd
        qty_raw  = (risk_usd * safe_lev) / (sl_dist * entry) if entry > 0 else 0
        min_qty  = _MIN_ORDER_QTY.get(sym, 0.001)
        qty      = max(round(qty_raw, 3), min_qty)
        side     = "Buy" if signal.direction.value == "LONG" else "Sell"

        try:
            result = await bybit_place_market_order(
                api_key, api_secret, sym, side,
                str(qty), sl, tp, safe_lev, margin_type,
            )
            trade_id = (
                result.get("result", {}).get("orderId", "")
                or result.get("result", {}).get("orderLinkId", "")
            )
            # Lock the instrument to prevent signal spam
            _trade_tracker.lock(sym, signal.direction.value, entry, trade_id)
            logger.info(
                "✅ AutoExec ORDER PLACED: %s %s %s  qty=%.3f  lev=%d×  "
                "entry=%.4f  sl=%.4f  tp=%.4f  clerk=%s…",
                sym, side, margin_type, qty, safe_lev,
                entry, sl, tp, clerk_id[:8],
            )
        except Exception as exc:
            logger.error("AutoExec ORDER FAILED %s for %s…: %s", sym, clerk_id[:8], exc)


async def bybit_refresh_loop() -> None:
    FETCH_TIMEOUT = 20.0
    MAX_BACKOFF   = 60.0
    fail_counts: dict[str, int] = {sym: 0 for sym in BYBIT_SYMBOLS}

    async def _safe_candles(sym: str, iv: str) -> list[Candle] | None:
        try:
            return await asyncio.wait_for(
                bybit_fetch_candles(sym, iv, limit=200),
                timeout=FETCH_TIMEOUT,
            )
        except asyncio.TimeoutError:
            logger.warning("Bybit timeout %ss: %s %s", FETCH_TIMEOUT, sym, iv)
        except Exception as exc:
            logger.warning("Bybit candle error %s %s: %s", sym, iv, exc)
        fail_counts[sym] = fail_counts.get(sym, 0) + 1
        return None

    while True:
        try:
            # ── 1. Refresh tickers (single public request) ──────────────────
            try:
                ticker_data = await asyncio.wait_for(
                    bybit_fetch_tickers(BYBIT_SYMBOLS), timeout=15.0,
                )
                for sym, meta in ticker_data.items():
                    _bybit_prices[sym] = meta["price"]
                    _bybit_meta[sym]   = meta
            except Exception as tick_exc:
                logger.warning("Bybit ticker refresh: %s", tick_exc)

            # ── 2. Refresh candles + SMC per symbol ─────────────────────────
            for sym in BYBIT_SYMBOLS:
                fails   = fail_counts.get(sym, 0)
                backoff = min(5.0 * (2 ** max(0, fails - 1)), MAX_BACKOFF) if fails > 0 else 0.0
                if backoff:
                    await asyncio.sleep(backoff)

                for iv in BYBIT_INTERVALS:
                    result = await _safe_candles(sym, iv)
                    if result is not None:
                        _bybit_candle_cache[sym][iv] = result
                        if result:
                            fail_counts[sym] = 0

                # ── SMC on H1 — minimum 60 candles for valid 50-EMA ─────────
                try:
                    h1    = _bybit_candle_cache[sym]["60"]
                    price = _bybit_prices.get(sym)
                    if price and len(h1) >= 60:
                        signal: Optional[TradeSignal] = _bybit_engines[sym].analyze(
                            h1, price, int(time.time()),
                        )
                        if signal:
                            # ── Signal deduplication: skip if instrument locked ──
                            if _trade_tracker.is_locked(sym):
                                logger.debug(
                                    "TradeTracker: SKIP %s %s — instrument locked",
                                    sym, signal.direction.value,
                                )
                            else:
                                sig_dict = {
                                    "type":       "BYBIT_SIGNAL",
                                    "symbol":     sym,
                                    "instrument": sym,
                                    "direction":  signal.direction.value,
                                    "entry":      round(signal.entry_price,     5),
                                    "sl":         round(signal.stop_loss,       5),
                                    "tp":         round(signal.take_profit,     5),
                                    "breakeven":  round(signal.breakeven_price, 5),
                                    "rr":         signal.risk_reward,
                                    "confidence": signal.confidence,
                                    "layer1":     signal.layer1_bias,
                                    "layer2":     signal.layer2_zone,
                                    "layer3":     signal.layer3_mss,
                                    "timestamp":  signal.timestamp,
                                }
                                _bybit_signal_history[sym] = (
                                    [sig_dict] + _bybit_signal_history[sym]
                                )[:50]
                                logger.info("BYBIT SIGNAL: %s %s  conf=%d%%  rr=1:%.1f",
                                            sym, signal.direction.value,
                                            signal.confidence, signal.risk_reward)

                                # ── Push notification (≥95% confluence) ────────
                                if signal.confidence >= 95:
                                    label      = sym.replace("USDT", "/USDT")
                                    push_title = f"🚨 Crypto Setup: {label} {signal.direction.value.title()}"
                                    push_body  = (
                                        f"Entry {signal.entry_price:.4f}  ·  "
                                        f"{signal.confidence}% confluence  ·  "
                                        f"R:R 1:{signal.risk_reward}"
                                    )
                                    asyncio.create_task(_send_onesignal_push(
                                        title = push_title,
                                        body  = push_body,
                                        data  = {
                                            "symbol":     sym,
                                            "direction":  signal.direction.value,
                                            "entry":      round(signal.entry_price, 5),
                                            "confidence": signal.confidence,
                                            "engine":     "BYBIT",
                                        },
                                    ))

                                # ── Auto-execution at 100% confluence ───────────
                                if signal.confidence >= 100:
                                    asyncio.create_task(
                                        _bybit_auto_execute(sym, sig_dict, signal)
                                    )
                except Exception as smc_exc:
                    logger.warning("Bybit SMC error %s: %s", sym, smc_exc)

        except Exception as loop_exc:
            logger.error("bybit_refresh_loop error: %s — restart in 15s", loop_exc)
            await asyncio.sleep(15)
            continue

        await asyncio.sleep(60)


# ─────────────────────────────────────────────────────────────────────────────
#  Oanda background tasks
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
    if not ONESIGNAL_APP_ID or not ONESIGNAL_REST_KEY:
        return
    if not _push_subscriptions:
        return
    payload = {
        "app_id":                   ONESIGNAL_APP_ID,
        "include_subscription_ids": list(_push_subscriptions),
        "headings":                 {"en": title},
        "contents":                 {"en": body},
        "data":                     data,
        "android_vibrate":          True,
        "ios_sound":                "default",
        "android_sound":            "default",
        "collapse_id":              data.get("instrument", data.get("symbol", "fx-radiant")),
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
            logger.info("📲 Push sent to %d sub(s): %s", len(_push_subscriptions), body[:60])
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
                        signal: Optional[TradeSignal] = _engines[ins].analyze(
                            h1, price, int(time.time())
                        )
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
                            if signal.confidence >= 95:
                                asyncio.create_task(_send_onesignal_push(
                                    title = f"🚨 High Probability Setup: {ins.replace('_','/')} {signal.direction.value.title()}",
                                    body  = (
                                        f"Entry at {signal.entry_price:.5f}  ·  "
                                        f"{signal.confidence}% confluence  ·  "
                                        f"R:R 1:{signal.risk_reward}"
                                    ),
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
    logger.info("  FX Radiant v2.3 — Oanda + Bybit dual engine")
    await _fetch_clerk_jwks()

    logger.info("  OANDA_API_KEY       : %s",
                "✅ set" if os.environ.get("OANDA_API_KEY",    "").strip() else "❌ MISSING")
    logger.info("  OANDA_ACCOUNT_ID    : %s",
                "✅ set" if os.environ.get("OANDA_ACCOUNT_ID", "").strip() else "❌ MISSING")
    logger.info("  BYBIT_READ_ONLY_KEY : %s",
                "✅ set" if BYBIT_READ_ONLY_KEY else "⚠️  not set (public market data only)")
    logger.info("  SUPABASE_URL        : %s",
                "✅ set" if SUPABASE_URL else "⚠️  not set (env-only credentials)")
    logger.info("  Clerk keys cached : %d", len(_clerk_jwks))
    logger.info("━" * 60)

    # ── Seed Oanda candles ───────────────────────────────────────────────────
    async def _safe_oanda_seed(ins: str, gran: str):
        try:
            return ins, gran, await asyncio.wait_for(
                fetch_candles(ins, gran), timeout=20.0,
            )
        except Exception as exc:
            logger.warning("Oanda seed %s %s: %s", ins, gran, exc)
        return ins, gran, None

    oanda_results = await asyncio.gather(*[
        _safe_oanda_seed(i, g) for i in INSTRUMENTS for g in GRANULARITIES
    ])
    oanda_seeded = 0
    for ins, gran, candles in oanda_results:
        if candles is not None:
            _candle_cache[ins][gran] = candles
            oanda_seeded += 1
    logger.info("Oanda candle seed: %d/%d loaded", oanda_seeded, len(oanda_results))

    # ── Seed Bybit tickers ───────────────────────────────────────────────────
    try:
        ticker_data = await asyncio.wait_for(
            bybit_fetch_tickers(BYBIT_SYMBOLS), timeout=12.0,
        )
        for sym, meta in ticker_data.items():
            _bybit_prices[sym] = meta["price"]
            _bybit_meta[sym]   = meta
        logger.info("Bybit tickers: %d symbols loaded", len(ticker_data))
    except Exception as exc:
        logger.warning("Bybit ticker seed: %s", exc)

    # ── Seed Bybit candles (H1 + M15 for fast startup) ───────────────────────
    async def _safe_bybit_seed(sym: str, iv: str):
        try:
            return sym, iv, await asyncio.wait_for(
                bybit_fetch_candles(sym, iv, limit=200), timeout=15.0,
            )
        except Exception as exc:
            logger.warning("Bybit seed %s %s: %s", sym, iv, exc)
        return sym, iv, None

    bybit_results = await asyncio.gather(*[
        _safe_bybit_seed(s, iv)
        for s in BYBIT_SYMBOLS
        for iv in ("60", "15")
    ])
    bybit_seeded = 0
    for sym, iv, candles in bybit_results:
        if candles is not None:
            _bybit_candle_cache[sym][iv] = candles
            bybit_seeded += 1
    logger.info("Bybit candle seed: %d/%d loaded (H1+M15)", bybit_seeded, len(bybit_results))

    asyncio.create_task(price_stream_loop())
    asyncio.create_task(candle_refresh_loop())
    asyncio.create_task(bybit_refresh_loop())
    yield


# ─────────────────────────────────────────────────────────────────────────────
#  FastAPI app + CORS + global error handler
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="FX Radiant API",
    version="2.2.0",
    description="SMC/ICT — Oanda + Bybit dual engine, Clerk JWT auth",
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

class OandaCredentialsRequest(BaseModel):
    oanda_api_key:    str
    oanda_account_id: str

class BybitCredentialsRequest(BaseModel):
    bybit_api_key:    str
    bybit_api_secret: str

class PushRegisterRequest(BaseModel):
    player_id: str


class BybitSettingsRequest(BaseModel):
    bybit_auto_trade:  Optional[bool]  = None
    bybit_leverage:    Optional[int]   = None   # 10–50
    bybit_margin_type: Optional[str]   = None   # "ISOLATED" | "CROSS"

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
    Return backend settings for this user, including both Oanda and Bybit
    credential hints so the Profile page renders both sections correctly.
    """
    clerk_id = payload["sub"]
    s = _settings(clerk_id)

    # Lazily populate Oanda account_id
    account_id = s.get("oanda_account_id", "")
    if not account_id and SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
        try:
            creds = await _get_user_oanda_creds(clerk_id)
            if creds:
                account_id = creds[1]
                s["oanda_account_id"] = account_id
        except Exception:
            pass

    # Lazily populate Bybit hints from personal Supabase row (not global fallback)
    bybit_key_hint    = s.get("bybit_key_hint",    "")
    bybit_secret_hint = s.get("bybit_secret_hint", "")
    if not bybit_key_hint and SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
        try:
            url     = f"{SUPABASE_URL}/rest/v1/users"
            headers = {
                "apikey":        SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            }
            params = {
                "clerk_id": f"eq.{clerk_id}",
                "select":   "bybit_api_key,bybit_api_secret",
            }
            async with httpx.AsyncClient(timeout=5) as client:
                r    = await client.get(url, headers=headers, params=params)
                rows = r.json() if r.status_code == 200 else []
            if rows and rows[0].get("bybit_api_key"):
                bybit_key_hint    = rows[0]["bybit_api_key"][-4:]
                bybit_secret_hint = (rows[0].get("bybit_api_secret") or "")[-4:]
                s["bybit_key_hint"]    = bybit_key_hint
                s["bybit_secret_hint"] = bybit_secret_hint
        except Exception:
            pass

    return {
        "clerk_id":           clerk_id,
        "auto_trade_enabled": s["auto_trade_enabled"],
        "risk_pct":           s["risk_pct"],
        "oanda_key_hint":     s["oanda_key_hint"],
        "oanda_account_id":   account_id,
        "bybit_key_hint":     bybit_key_hint,
        "bybit_secret_hint":  bybit_secret_hint,
        # Bybit trading preferences
        "bybit_auto_trade":   s.get("bybit_auto_trade",  False),
        "bybit_leverage":     s.get("bybit_leverage",    BYBIT_DEFAULT_LEVERAGE),
        "bybit_margin_type":  s.get("bybit_margin_type", "ISOLATED"),
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


@app.post("/api/users/me/oanda-credentials")
async def save_oanda_credentials(
    body:    OandaCredentialsRequest,
    payload: dict = Depends(get_current_user),
):
    clerk_id   = payload["sub"]
    api_key    = body.oanda_api_key.strip()
    account_id = body.oanda_account_id.strip()
    if not api_key or not account_id:
        raise HTTPException(400, "Both oanda_api_key and oanda_account_id are required")
    try:
        await fetch_account_summary(api_key, account_id)
    except Exception:
        raise HTTPException(422, "Could not verify credentials — check your Oanda API key and account ID")
    await _upsert_user_oanda_creds(clerk_id, api_key, account_id)
    s = _settings(clerk_id)
    s["oanda_key_hint"]   = api_key[-4:]
    s["oanda_account_id"] = account_id
    return {
        "saved":            True,
        "oanda_account_id": account_id,
        "oanda_key_hint":   api_key[-4:],
    }


@app.post("/api/users/me/bybit-credentials")
async def save_bybit_credentials(
    body:    BybitCredentialsRequest,
    payload: dict = Depends(get_current_user),
):
    """
    Validate and persist the user's Bybit API key + secret.

    1. Both fields required
    2. Verify by calling bybit_verify_credentials() — any error → HTTP 422
    3. Upsert into Supabase (bybit_api_key, bybit_api_secret columns)
    4. Cache last-4-char hints in _user_settings for immediate /auth/me hydration
    """
    clerk_id   = payload["sub"]
    api_key    = body.bybit_api_key.strip()
    api_secret = body.bybit_api_secret.strip()
    if not api_key or not api_secret:
        raise HTTPException(400, "Both bybit_api_key and bybit_api_secret are required")
    try:
        await bybit_verify_credentials(api_key, api_secret)
    except Exception as exc:
        raise HTTPException(422, f"Could not verify Bybit credentials: {exc}")
    await _upsert_user_bybit_creds(clerk_id, api_key, api_secret)
    s = _settings(clerk_id)
    s["bybit_key_hint"]    = api_key[-4:]
    s["bybit_secret_hint"] = api_secret[-4:]
    return {
        "saved":             True,
        "bybit_key_hint":    api_key[-4:],
        "bybit_secret_hint": api_secret[-4:],
    }


@app.post("/api/push/register")
async def register_push(
    body:    PushRegisterRequest,
    payload: dict = Depends(get_current_user),
):
    pid = body.player_id.strip()
    if not pid:
        raise HTTPException(400, "player_id is required")
    _push_subscriptions.add(pid)
    logger.info("📲 Push registered: %s… (%d total)", pid[:8], len(_push_subscriptions))
    return {"registered": True, "total_subscribers": len(_push_subscriptions)}


# ─────────────────────────────────────────────────────────────────────────────
#  Oanda market data routes
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
async def get_candles(
    instrument:  str,
    granularity: str = "H1",
    count:       int = 120,
    _: dict = Depends(get_current_user),
):
    if instrument not in _candle_cache:
        raise HTTPException(404, "Instrument not found")
    n       = max(1, min(count, 500))
    candles = _candle_cache[instrument].get(granularity, [])
    return [
        {"t": c.time, "o": c.open, "h": c.high, "l": c.low, "c": c.close, "v": c.volume}
        for c in candles[-n:]
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
    for s in _signal_history.values():
        all_signals.extend(s)
    return sorted(all_signals, key=lambda s: s["timestamp"], reverse=True)[:100]


# ─────────────────────────────────────────────────────────────────────────────
#  Bybit trading settings & trade tracker routes
# ─────────────────────────────────────────────────────────────────────────────

@app.patch("/api/bybit/settings")
async def update_bybit_settings(
    body:    BybitSettingsRequest,
    payload: dict = Depends(get_current_user),
):
    """
    Update per-user Bybit trading settings:
      • bybit_auto_trade  — enable/disable auto-execution
      • bybit_leverage    — 10–50× (default 20)
      • bybit_margin_type — "ISOLATED" | "CROSS"
    """
    clerk_id = payload["sub"]
    s = _settings(clerk_id)

    if body.bybit_auto_trade is not None:
        s["bybit_auto_trade"] = body.bybit_auto_trade
        logger.info(
            "Bybit auto-trade %s for %s…",
            "ENABLED" if body.bybit_auto_trade else "DISABLED",
            clerk_id[:8],
        )

    if body.bybit_leverage is not None:
        s["bybit_leverage"] = max(1, min(50, int(body.bybit_leverage)))

    if body.bybit_margin_type is not None:
        if body.bybit_margin_type not in ("ISOLATED", "CROSS"):
            raise HTTPException(400, "bybit_margin_type must be 'ISOLATED' or 'CROSS'")
        s["bybit_margin_type"] = body.bybit_margin_type

    return {
        "clerk_id":          clerk_id,
        "bybit_auto_trade":  s["bybit_auto_trade"],
        "bybit_leverage":    s["bybit_leverage"],
        "bybit_margin_type": s["bybit_margin_type"],
    }


@app.get("/api/bybit/settings")
async def get_bybit_settings(payload: dict = Depends(get_current_user)):
    """Return current Bybit trading settings for this user."""
    clerk_id = payload["sub"]
    s = _settings(clerk_id)
    return {
        "bybit_auto_trade":  s.get("bybit_auto_trade",  False),
        "bybit_leverage":    s.get("bybit_leverage",    BYBIT_DEFAULT_LEVERAGE),
        "bybit_margin_type": s.get("bybit_margin_type", "ISOLATED"),
    }


@app.get("/api/bybit/trade-locks")
async def get_trade_locks(_: dict = Depends(get_current_user)):
    """
    Return currently locked symbols (instruments with an active open trade).
    Used by the frontend to show lock status on signal cards.
    """
    return _trade_tracker.all_locks()


@app.delete("/api/bybit/trade-locks/{symbol}")
async def release_trade_lock(symbol: str, _: dict = Depends(get_current_user)):
    """Manually release a trade lock for a symbol (e.g. after manual close)."""
    if symbol not in BYBIT_SYMBOLS:
        raise HTTPException(404, f"Symbol '{symbol}' not tracked")
    _trade_tracker.unlock(symbol)
    return {"unlocked": True, "symbol": symbol}


# ─────────────────────────────────────────────────────────────────────────────
#  Bybit market data routes  (no credentials — all public data)
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/bybit/market")
async def bybit_market(_: dict = Depends(get_current_user)):
    """
    SMC state + 24 h stats for all 15 Bybit Linear symbols.
    Mirrors GET /api/markets.  All data from the public-endpoint cache.
    Sorted by 24 h USDT turnover descending — highest-liquidity pairs first.
    """
    result = []
    for sym in BYBIT_SYMBOLS:
        price = _bybit_prices.get(sym, 0.0)
        h1    = _bybit_candle_cache[sym]["60"]
        meta  = _bybit_meta.get(sym, {})
        state = (
            _bybit_engines[sym].get_partial_state(h1, price)
            if (price and len(h1) >= 60)
            else None
        )
        result.append({
            "symbol":     sym,
            "price":      price,
            "confidence": state.confidence        if state else 0,
            "bias":       state.layer1_bias.value if state else "NEUTRAL",
            "layer2":     state.layer2_active     if state else False,
            "layer3":     state.layer3_mss        if state else False,
            "high24h":    meta.get("high24h",   0.0),
            "low24h":     meta.get("low24h",    0.0),
            "volume24h":  meta.get("volume24h", 0.0),
            "change24h":  round(meta.get("change24h", 0.0), 2),
        })
    result.sort(key=lambda x: x["volume24h"], reverse=True)
    return result


@app.get("/api/bybit/candles/{symbol}")
async def bybit_candles(
    symbol:   str,
    interval: str = "60",
    limit:    int = 120,
    _: dict = Depends(get_current_user),
):
    """
    Return cached Bybit candles.  interval: "1"|"5"|"15"|"60"

    Cold-cache live fetch if the interval hasn't been seeded yet.
    """
    if symbol not in _bybit_candle_cache:
        raise HTTPException(404, f"Symbol '{symbol}' not tracked")
    if interval not in BYBIT_INTERVALS:
        raise HTTPException(400, f"interval must be one of {BYBIT_INTERVALS}")

    n       = max(1, min(limit, 500))
    candles = _bybit_candle_cache[symbol].get(interval, [])

    if not candles:
        try:
            candles = await asyncio.wait_for(
                bybit_fetch_candles(symbol, interval, limit=200),
                timeout=15.0,
            )
            _bybit_candle_cache[symbol][interval] = candles
        except Exception as exc:
            logger.warning("Bybit live fetch %s %s: %s", symbol, interval, exc)
            return []

    return [
        {"t": c.time, "o": c.open, "h": c.high, "l": c.low, "c": c.close, "v": c.volume}
        for c in candles[-n:]
    ]


@app.get("/api/bybit/signals")
async def bybit_signals(_: dict = Depends(get_current_user)):
    """
    All active Bybit SMC signals across 15 symbols, sorted newest-first.
    """
    all_signals: list[dict] = []
    for s in _bybit_signal_history.values():
        all_signals.extend(s)
    return sorted(all_signals, key=lambda s: s["timestamp"], reverse=True)[:100]


# ─────────────────────────────────────────────────────────────────────────────
#  Bybit account routes  (require credentials)
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/bybit/account")
async def bybit_account_route(payload: dict = Depends(get_current_user)):
    """
    Fetch Bybit Unified Trading Account balance.
    Returns: accountType, totalEquity, totalAvailable, totalMargin, totalUSDT, coin[]
    """
    clerk_id = payload["sub"]
    creds    = await _get_user_bybit_creds(clerk_id)
    if not creds:
        raise HTTPException(
            422,
            "No Bybit credentials configured — add your API key in Profile → Bybit Credentials",
        )
    try:
        return await bybit_fetch_account(*creds)
    except Exception as exc:
        raise HTTPException(503, f"Bybit account error: {exc}")


@app.get("/api/bybit/account/positions")
async def bybit_positions_route(payload: dict = Depends(get_current_user)):
    """Open Bybit Linear positions. Returns [] when no positions are open."""
    clerk_id = payload["sub"]
    creds    = await _get_user_bybit_creds(clerk_id)
    if not creds:
        raise HTTPException(
            422,
            "No Bybit credentials configured — add your API key in Profile → Bybit Credentials",
        )
    try:
        return await bybit_fetch_positions(*creds)
    except Exception as exc:
        raise HTTPException(503, f"Bybit positions error: {exc}")


@app.get("/api/bybit/account/history")
async def bybit_trade_history_route(
    payload: dict = Depends(get_current_user),
    limit:   int  = 50,
):
    """Recent Bybit execution history. limit capped at 100."""
    clerk_id = payload["sub"]
    creds    = await _get_user_bybit_creds(clerk_id)
    if not creds:
        raise HTTPException(
            422,
            "No Bybit credentials configured — add your API key in Profile → Bybit Credentials",
        )
    try:
        return await bybit_fetch_trade_history(*creds, limit=min(limit, 100))
    except Exception as exc:
        raise HTTPException(503, f"Bybit history error: {exc}")


# ─────────────────────────────────────────────────────────────────────────────
#  Oanda Account & Orders routes
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/account")
async def get_account(payload: dict = Depends(get_current_user)):
    clerk_id = payload["sub"]
    creds    = await _get_user_oanda_creds(clerk_id)
    if not creds:
        raise HTTPException(422, "No Oanda credentials saved — add them in Profile → Oanda Credentials")
    try:
        return await fetch_account_summary(*creds)
    except Exception as e:
        raise HTTPException(503, f"Oanda error: {e}")


@app.get("/api/account/trades")
async def get_open_trades(payload: dict = Depends(get_current_user)):
    clerk_id = payload["sub"]
    creds    = await _get_user_oanda_creds(clerk_id)
    if not creds:
        raise HTTPException(422, "No Oanda credentials saved — add them in Profile → Oanda Credentials")
    try:
        return await fetch_open_trades(*creds)
    except Exception as e:
        raise HTTPException(503, f"Oanda error: {e}")


@app.get("/api/account/history")
async def get_trade_history(payload: dict = Depends(get_current_user)):
    clerk_id = payload["sub"]
    creds    = await _get_user_oanda_creds(clerk_id)
    if not creds:
        raise HTTPException(422, "No Oanda credentials saved — add them in Profile → Oanda Credentials")
    try:
        return await fetch_trade_history(*creds, count=50)
    except Exception as e:
        raise HTTPException(503, f"Oanda error: {e}")


@app.post("/api/orders")
async def create_order(body: OrderRequest, payload: dict = Depends(get_current_user)):
    clerk_id = payload["sub"]
    creds    = await _get_user_oanda_creds(clerk_id)
    if not creds:
        raise HTTPException(422, "No Oanda credentials saved — add them in Profile → Oanda Credentials")
    try:
        return await place_market_order(*creds, body.instrument, body.units, body.stop_loss, body.take_profit)
    except Exception as e:
        raise HTTPException(503, f"Order error: {e}")


# ─────────────────────────────────────────────────────────────────────────────
#  WebSocket — real-time Oanda feed
# ─────────────────────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str = ""):
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
        "status":               "ok",
        "version":              "2.4.0",
        "auth":                 "clerk",
        "jwks_keys":            len(_clerk_jwks),
        "ws_clients":           len(_ws_clients),
        "oanda_prices_cached":  len(_latest_prices),
        "bybit_prices_cached":  sum(1 for p in _bybit_prices.values() if p > 0),
        "bybit_signals_total":  sum(len(v) for v in _bybit_signal_history.values()),
        "bybit_trade_locks":    len(_trade_tracker.all_locks()),
        "timestamp":            int(time.time()),
    }