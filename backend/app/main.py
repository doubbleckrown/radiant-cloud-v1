"""
FX Radiant — FastAPI Backend  v3.0  (Private Bot Mode)
=======================================================
• Clerk JWT Authentication (RS256 JWKS)
• Oanda v20 WebSocket price streaming + candle polling
• Bybit V5 Linear (Perpetuals) candle polling + ticker refresh
• SMC Confluence Engine — auto-executes at EXACTLY 100% confluence
• TradeTracker — one-position-per-instrument deduplication (2-h TTL)
• Env-only credentials — no Supabase, no per-user key storage

Elite 35 Instrument List:
  OANDA (16): 10 Forex + 3 Metals + 3 Indices
  BYBIT (19): 14 Blue-Chips + 5 Meme Coins (PEPE, BONK, FARTCOIN, XP, WLFI)

Engine design:
  OANDA  — ema_period=200, rr_ratio=3.0, H1 primary timeframe
  BYBIT  — ema_period=50,  rr_ratio=3.0, H1 primary timeframe
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

# ── Supabase — DISABLED in Private Bot Mode ───────────────────────────────
# SUPABASE_URL              = os.getenv("SUPABASE_URL", "")
# SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
SUPABASE_URL              = ""   # disabled
SUPABASE_SERVICE_ROLE_KEY = ""   # disabled

# ─────────────────────────────────────────────────────────────────────────────
#  Config — Bybit V5 Linear (Perpetuals)
# ─────────────────────────────────────────────────────────────────────────────

BYBIT_BASE = "https://api.bybit.com"

# ── Bybit execution credentials (private bot — env only) ─────────────────────
BYBIT_API_KEY    = os.getenv("BYBIT_API_KEY",    "")
BYBIT_API_SECRET = os.getenv("BYBIT_API_SECRET", "")

# Default leverage for all Bybit auto-execution orders
BYBIT_DEFAULT_LEVERAGE = int(os.getenv("BYBIT_DEFAULT_LEVERAGE", "20"))
BYBIT_MARGIN_TYPE      = os.getenv("BYBIT_MARGIN_TYPE", "ISOLATED")   # ISOLATED | CROSS

# ── Elite 19: 14 blue-chips + 5 meme coins ────────────────────────────────────
BYBIT_SYMBOLS = [
    # Blue-chip perpetuals
    "BTCUSDT",   "ETHUSDT",   "SOLUSDT",  "XRPUSDT",  "BNBUSDT",
    "DOGEUSDT",  "AVAXUSDT",  "ADAUSDT",  "DOTUSDT",  "LINKUSDT",
    "LTCUSDT",   "NEARUSDT",  "ATOMUSDT", "UNIUSDT",
    # Meme coins
    "1000PEPEUSDT", "1000BONKUSDT", "FARTCOINUSDT", "XPLUSDT", "WLFIUSDT",
]

# Bybit V5 interval strings: "60"=H1, "15"=M15, "5"=M5, "1"=M1
BYBIT_INTERVALS = ["60", "15", "5", "1"]

# ─────────────────────────────────────────────────────────────────────────────
#  Oanda instruments + granularities
# ─────────────────────────────────────────────────────────────────────────────

# ── Elite 16: 10 Forex + 3 Metals + 3 Indices ─────────────────────────────────
INSTRUMENTS = [
    # Forex (10)
    "EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "NZD_USD",
    "USD_CAD", "EUR_GBP", "GBP_JPY", "EUR_JPY", "AUD_CAD",
    # Metals (3)
    "XAU_USD", "XAG_USD", "XPT_USD",
    # Indices (3)
    "NAS100_USD", "SPX500_USD", "US30_USD",
]
GRANULARITIES = ["M1", "M5", "M15", "H1"]

logger = logging.getLogger("fx-radiant")
logging.basicConfig(level=logging.INFO)


# ─────────────────────────────────────────────────────────────────────────────
#  In-memory stores — Oanda
# ─────────────────────────────────────────────────────────────────────────────

_clerk_jwks:    dict[str, Any]  = {}
# _user_settings removed — Private Bot Mode uses .env credentials only

_candle_cache:   dict[str, dict[str, list[Candle]]] = {
    ins: {gran: [] for gran in GRANULARITIES} for ins in INSTRUMENTS
}
_latest_prices:  dict[str, float]       = {}
_ws_clients:     set[WebSocket]         = set()
_signal_history: dict[str, list[dict]]  = {ins: [] for ins in INSTRUMENTS}
_engines:        dict[str, SMCConfluenceEngine] = {
    # ema_period=200 — institutional-grade trend filter for Forex/Metals/Indices
    # rr_ratio=3.0   — 1:3 risk-reward matches Bybit spec (TP = entry ± 3× SL distance)
    ins: SMCConfluenceEngine(ins, ema_period=200, rr_ratio=3.0)
    for ins in INSTRUMENTS
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

# ── Settings file — persists risk_pct across server restarts ─────────────────
# Stored next to main.py as "settings.json".  Written on every update.
# On startup, loaded BEFORE the .env fallback so the last slider value wins.
_SETTINGS_DIR  = Path(__file__).resolve().parent / "user_settings"
_SETTINGS_DIR.mkdir(exist_ok=True)   # create dir on first import


def _user_settings_path(clerk_id: str) -> Path:
    """Return the settings file path for a specific Clerk user ID."""
    # Sanitize clerk_id — strip any path chars just in case
    safe_id = clerk_id.replace("/", "").replace("\\", "").replace("..", "")
    return _SETTINGS_DIR / f"user_{safe_id}_settings.json"


def _load_settings(clerk_id: str = "default") -> dict:
    """Load per-user settings from disk; return {} on missing/corrupt file."""
    path = _user_settings_path(clerk_id)
    try:
        if path.exists():
            with open(path, "r") as f:
                return json.load(f)
    except Exception as exc:
        logger.warning("settings load failed for %s: %s", clerk_id, exc)
    return {}


def _save_settings(data: dict, clerk_id: str = "default") -> None:
    """Atomically write per-user settings to disk."""
    path = _user_settings_path(clerk_id)
    try:
        tmp = path.with_suffix(".json.tmp")
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
        tmp.replace(path)
        logger.debug("Settings saved for %s: %s", clerk_id, data)
    except Exception as exc:
        logger.warning("Settings save failed for %s: %s", clerk_id, exc)

# ── Runtime-overridable risk % ────────────────────────────────────────────────
# Priority (highest → lowest):
#   1. _runtime_risk_pct  — set by POST /api/settings/update (in-memory, persisted to settings.json)
#   2. settings.json      — last value saved across restarts
#   3. BOT_RISK_PCT .env  — initial default (default 10.0)
_saved_settings   = _load_settings("default")
_runtime_risk_pct: float = float(_saved_settings.get("risk_pct", -1.0))

def _get_bot_risk_pct() -> float:
    """Return effective risk fraction (0.0–1.0). Runtime > settings.json > .env."""
    if _runtime_risk_pct >= 0:
        return _runtime_risk_pct / 100.0
    return float(os.getenv("BOT_RISK_PCT", "10.0")) / 100.0

def _effective_risk_pct_display() -> float:
    """Return the display value (percentage, not fraction) for API responses."""
    if _runtime_risk_pct >= 0:
        return _runtime_risk_pct
    return float(os.getenv("BOT_RISK_PCT", "10.0"))

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
    """
    In-memory trade lock registry.  Thread-safe via asyncio single-thread model.

    Each lock entry stores:
      direction  — "LONG" | "SHORT"
      entry      — fill/entry price
      sl         — stop-loss price  ← read by exit_monitor_loop for active TP/SL check
      tp         — take-profit price ← read by exit_monitor_loop
      trade_id   — broker order/trade ID (updated after fill)
      opened_at  — Unix timestamp at lock creation  ← TTL reference
      expires_at — opened_at + 7200 s  (hard 2-h kill)
    """

    def __init__(self) -> None:
        self._locks: dict[str, dict] = {}

    def is_locked(self, symbol: str) -> bool:
        lock = self._locks.get(symbol)
        if not lock:
            return False
        if time.time() > lock["expires_at"]:
            del self._locks[symbol]
            logger.info("TradeTracker: lock EXPIRED (2h TTL) for %s", symbol)
            return False
        return True

    def lock(
        self,
        symbol:    str,
        direction: str,
        entry:     float,
        trade_id:  str   = "",
        sl:        float = 0.0,
        tp:        float = 0.0,
    ) -> None:
        """
        Create or update a lock.  On the "pending → filled" update, the
        original opened_at is preserved so the TTL clock is not reset.
        sl and tp are only overwritten when non-zero so the pending lock
        (placed before order fill) can carry them through.
        """
        now      = time.time()
        existing = self._locks.get(symbol, {})
        opened   = existing.get("opened_at", now)  # preserve original open time
        self._locks[symbol] = {
            "direction":  direction,
            "entry":      entry,
            "sl":         sl   if sl   != 0.0 else existing.get("sl",   0.0),
            "tp":         tp   if tp   != 0.0 else existing.get("tp",   0.0),
            "trade_id":   trade_id,
            "opened_at":  opened,
            "expires_at": opened + TRADE_LOCK_TTL_SECONDS,
        }
        logger.info(
            "TradeTracker: LOCKED %s %s @ %.5f  sl=%.5f  tp=%.5f  (2h TTL from open)",
            symbol, direction, entry,
            self._locks[symbol]["sl"],
            self._locks[symbol]["tp"],
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
        """Return snapshot of active locks (pruning TTL-expired ones first)."""
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


def _get_oanda_creds() -> tuple[str, str] | None:
    """Return (api_key, account_id) from .env, or None if not configured."""
    key     = os.environ.get("OANDA_API_KEY",    "").strip()
    account = os.environ.get("OANDA_ACCOUNT_ID", "").strip()
    return (key, account) if (key and account) else None

# Alias for backward compat with API routes
async def _get_user_oanda_creds(_clerk_id: str = "") -> tuple[str, str] | None:
    return _get_oanda_creds()


# _upsert_user_oanda_creds removed — env-only mode

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


# ── Oanda instrument precision — Metals require specific unit handling ─────────
# XAU/XAG/XPT: Oanda accepts units in troy-ounce units (integers only, min 1)
# Indices (NAS100/SPX500/US30): units in integer lots
# Forex: integer units (full currency units), min 1
_OANDA_MIN_UNITS: dict[str, int] = {
    "XAU_USD": 1, "XAG_USD": 1, "XPT_USD": 1,   # metals — minimum 1 oz
    "NAS100_USD": 1, "SPX500_USD": 1, "US30_USD": 1,
}
# Metals & indices: SL/TP price format (2-4 decimal places, not 5)
_OANDA_SL_DECIMALS: dict[str, int] = {
    "XAU_USD": 3, "XAG_USD": 3, "XPT_USD": 3,
    "NAS100_USD": 1, "SPX500_USD": 1, "US30_USD": 1,
}

def _oanda_compute_units(instrument: str, risk_usd: float, sl_dist: float, is_long: bool) -> int:
    """
    Compute Oanda unit size safely for any instrument type.

    Forex  : units = risk_usd / sl_dist  (pip value ≈ $1 per 1 unit for USD-quote pairs)
    Metals : units = risk_usd / sl_dist  (same formula — sl_dist is in $/oz for XAU)
    Indices: units = risk_usd / (sl_dist * index_point_value) — point value ≈ $1

    Always returns a non-zero integer.  LONG → positive, SHORT → negative.
    """
    if sl_dist <= 0:
        return 0
    raw = risk_usd / sl_dist
    # For very small calculated sizes (e.g. XAU with tight SL), floor to minimum 1
    minimum = _OANDA_MIN_UNITS.get(instrument, 1)
    units   = max(int(raw), minimum)
    return units if is_long else -units


async def place_market_order(
    api_key: str, account_id: str,
    instrument: str, units: int, stop_loss: float, take_profit: float,
) -> dict:
    sl_dec = _OANDA_SL_DECIMALS.get(instrument, 5)
    url  = f"{OANDA_BASE}/v3/accounts/{account_id}/orders"
    body = {"order": {
        "type": "MARKET", "instrument": instrument, "units": str(units),
        "stopLossOnFill":   {"price": f"{stop_loss:.{sl_dec}f}"},
        "takeProfitOnFill": {"price": f"{take_profit:.{sl_dec}f}"},
        "timeInForce": "FOK",
    }}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, headers=_oanda_headers_for(api_key), json=body)
        resp.raise_for_status()
    return resp.json()


async def close_oanda_trade(api_key: str, account_id: str, trade_id: str) -> dict:
    """
    Close a specific Oanda trade at market price.

    Oanda v20 spec:
      PUT /v3/accounts/{accountID}/trades/{tradeSpecifier}/close
      Body: {"units": "ALL"}  — closes the full position
      tradeSpecifier must be the numeric trade ID string (e.g. "12345")
    """
    url = f"{OANDA_BASE}/v3/accounts/{account_id}/trades/{trade_id}/close"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.put(
            url,
            headers=_oanda_headers_for(api_key),
            json={"units": "ALL"},   # "ALL" = close entire position at market
        )
        resp.raise_for_status()
    return resp.json()


async def close_bybit_position(
    api_key: str, api_secret: str, symbol: str, side: str, qty: str,
) -> dict:
    """
    Close a Bybit Linear (USDT perpetual) position at market price.

    Bybit V5 spec for reduce-only market close:
      POST /v5/order/create
      category   = "linear"  — identifies USDT perpetual contract type (required)
      orderType  = "Market"  — fills immediately at best available price
      side       = opposite of the open position side
      reduceOnly = True      — guarantees this order only reduces, never opens
      timeInForce = "IOC"    — required for Market orders per V5 spec
      positionIdx = 0        — one-way mode (Unified Account default)
    """
    close_side = "Sell" if side == "Buy" else "Buy"
    body = {
        "category":    "linear",
        "symbol":      symbol,
        "side":        close_side,
        "orderType":   "Market",
        "qty":         qty,
        "timeInForce": "IOC",
        "positionIdx": 0,
        "reduceOnly":  True,
    }
    _, headers = _bybit_sign_post(api_key, api_secret, body)
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(
            f"{BYBIT_BASE}/v5/order/create",
            headers=headers, json=body,
        )
        resp.raise_for_status()
    data = resp.json()
    _bybit_raise_on_error(data, f"close_bybit_position {symbol}")
    logger.info("✅ Bybit position closed: %s %s qty=%s", symbol, close_side, qty)
    return data




# ─────────────────────────────────────────────────────────────────────────────
#  Bybit credential helpers — env-only (Private Bot Mode)
# ─────────────────────────────────────────────────────────────────────────────

def _get_bybit_creds() -> tuple[str, str] | None:
    """Return (api_key, api_secret) from .env, or None if not configured."""
    key    = os.environ.get("BYBIT_API_KEY",    "").strip()
    secret = os.environ.get("BYBIT_API_SECRET", "").strip()
    return (key, secret) if (key and secret) else None

# Alias for backward compat with API routes
async def _get_user_bybit_creds(_clerk_id: str = "") -> tuple[str, str] | None:
    return _get_bybit_creds()


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
#  Bybit V5 — HMAC-SHA256 signing helpers  (strict spec implementation)
# ─────────────────────────────────────────────────────────────────────────────
#
#  Bybit V5 signature string:
#    GET  : ts + apiKey + recvWindow + queryString   (raw, NOT url-encoded again)
#    POST : ts + apiKey + recvWindow + json_body      (compact JSON, no spaces)
#
#  Headers required on every authenticated request:
#    X-BAPI-API-KEY        — your API key
#    X-BAPI-SIGN           — hex HMAC-SHA256 of the signature string
#    X-BAPI-TIMESTAMP      — Unix ms as string (must be within recv_window of server time)
#    X-BAPI-RECV-WINDOW    — "5000" (max 5000 recommended by Bybit)
#    X-BAPI-SIGN-TYPE      — "2" (HMAC-SHA256)
#
#  Error 10004 = invalid signature — most common causes:
#    1. Server clock skew > recv_window  →  use NTP / ensure system time is synced
#    2. Wrong string order              →  ts FIRST, then api_key, then rw, then payload
#    3. Extra spaces in JSON body       →  use separators=(",",":")
#    4. Params double-encoded in GET    →  build qs from sorted items ONCE
# ─────────────────────────────────────────────────────────────────────────────

BYBIT_RECV_WINDOW = "5000"   # kept as string — Bybit spec requires string comparison


def _bybit_timestamp() -> str:
    """Return current UTC time as integer milliseconds string."""
    return str(int(time.time() * 1000))


def _bybit_sign(api_secret: str, payload: str) -> str:
    """HMAC-SHA256 of payload string. Returns lowercase hex digest."""
    return hmac.new(
        api_secret.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _bybit_headers(api_key: str, sig: str, ts: str) -> dict:
    """Return the five required Bybit V5 authentication headers."""
    return {
        "X-BAPI-API-KEY":     api_key,
        "X-BAPI-SIGN":        sig,
        "X-BAPI-TIMESTAMP":   ts,
        "X-BAPI-RECV-WINDOW": BYBIT_RECV_WINDOW,
        "X-BAPI-SIGN-TYPE":   "2",
        "Content-Type":       "application/json",
    }


def _bybit_sign_get(api_key: str, api_secret: str, params: dict) -> tuple[dict, dict]:
    """
    Sign a Bybit V5 GET request.

    Query string is built from sorted key-value pairs so it is deterministic.
    Signature string: ts + apiKey + recvWindow + queryString

    Returns (params, headers) — params is unchanged (caller adds to url).
    """
    ts  = _bybit_timestamp()
    qs  = urllib.parse.urlencode(sorted(params.items()))
    sig = _bybit_sign(api_secret, ts + api_key + BYBIT_RECV_WINDOW + qs)
    return params, _bybit_headers(api_key, sig, ts)


def _bybit_sign_post(api_key: str, api_secret: str, body: dict) -> tuple[dict, dict]:
    """
    Sign a Bybit V5 POST request.

    Body is serialized to compact JSON (no spaces).
    Signature string: ts + apiKey + recvWindow + jsonBody

    Returns (body, headers).
    """
    ts  = _bybit_timestamp()
    jb  = json.dumps(body, separators=(",", ":"), ensure_ascii=True)
    sig = _bybit_sign(api_secret, ts + api_key + BYBIT_RECV_WINDOW + jb)
    return body, _bybit_headers(api_key, sig, ts)


def _bybit_raise_on_error(data: dict, context: str = "") -> None:
    """
    Raise a descriptive RuntimeError if Bybit returned a non-zero retCode.

    Bybit error codes relevant to auth:
      10003 — API key does not exist
      10004 — Invalid signature (clock skew or wrong string)
      10005 — API key expired
      10006 — Rate limit hit
    """
    ret  = data.get("retCode", -1)
    if ret == 0:
        return
    msg  = data.get("retMsg", "Unknown error")
    hint = ""
    if ret == 10004:
        hint = " — CHECK: system clock sync (NTP), API key permissions, IP whitelist"
    elif ret == 10003:
        hint = " — API key not found; check BYBIT_API_KEY in .env"
    elif ret == 10005:
        hint = " — API key expired; regenerate in Bybit dashboard"
    raise RuntimeError(f"Bybit retCode {ret}: {msg}{hint} [{context}]")



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
    _bybit_raise_on_error(data, "bybit_fetch_account")

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

    # Bybit V5 spec: stopLoss and takeProfit must be strings; tpTriggerBy /
    # slTriggerBy default to "LastPrice" if omitted but "MarkPrice" is safer
    # for perps as it avoids wick-triggered exits on thin books.
    # timeInForce for Market orders must be "IOC" or "FOK"; SL/TP are
    # attached to the *position*, not the order, so they persist after fill.
    body = {
        "category":    "linear",
        "symbol":      symbol,
        "side":        side,
        "orderType":   "Market",
        "qty":         qty,
        "stopLoss":    f"{stop_loss:.4f}",     # string price as required by V5 spec
        "takeProfit":  f"{take_profit:.4f}",   # string price as required by V5 spec
        "tpTriggerBy": "MarkPrice",            # trigger TP on mark price (avoids wick)
        "slTriggerBy": "MarkPrice",            # trigger SL on mark price
        "timeInForce": "IOC",
        "positionIdx": 0,   # 0 = one-way mode (required for Unified Account)
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
    # Blue-chip perpetuals
    "BTCUSDT": 0.001, "ETHUSDT": 0.01,  "SOLUSDT": 0.1,  "XRPUSDT":   10.0,
    "BNBUSDT": 0.01,  "DOGEUSDT": 100.0,"AVAXUSDT": 0.1,  "ADAUSDT":   10.0,
    "DOTUSDT": 1.0,   "LINKUSDT": 1.0,  "LTCUSDT":  0.1,  "NEARUSDT":   1.0,
    "ATOMUSDT": 1.0,  "UNIUSDT":  1.0,
    # Meme coins (large qty per lot)
    "1000PEPEUSDT": 100.0, "1000BONKUSDT": 100.0, "FARTCOINUSDT": 1.0,
    "XPLUSDT": 1.0,        "WLFIUSDT": 10.0,
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


async def _bybit_auto_execute(sym: str, sig_dict: dict, signal) -> None:
    """
    Hard-automate: place a Bybit market order for every 100% confluence signal.
    Uses BYBIT_API_KEY / BYBIT_API_SECRET from .env — no user loop.
    TradeTracker is locked BEFORE the order to prevent re-entry.
    On success: sig_dict['exec_status'] = 'ok', 'exec_order_id' = orderId
    On failure: sig_dict['exec_status'] = 'failed', 'exec_error' = error message
    """
    if _trade_tracker.is_locked(sym):
        logger.info("AutoExec BYBIT: %s already locked — skip", sym)
        return

    creds = _get_bybit_creds()
    if not creds:
        logger.warning("AutoExec BYBIT: BYBIT_API_KEY/SECRET not configured in .env")
        sig_dict["exec_status"] = "failed"
        sig_dict["exec_error"]  = "BYBIT_API_KEY/SECRET not configured in .env"
        return

    api_key, api_secret = creds

    try:
        account_data = await bybit_fetch_account(api_key, api_secret)
        equity = float(account_data.get("totalEquity", 0) or 0)
        if equity <= 0:
            logger.warning("AutoExec BYBIT: zero equity — skip %s", sym)
            sig_dict["exec_status"] = "failed"
            sig_dict["exec_error"]  = "Zero account equity"
            return

        leverage    = BYBIT_DEFAULT_LEVERAGE
        margin_type = BYBIT_MARGIN_TYPE
        risk_pct    = _get_bot_risk_pct()
        risk_usd    = equity * risk_pct

        # ── Floor: Bybit requires at least ~$1.20 initial margin per order ──
        BYBIT_MIN_MARGIN = 1.20
        if risk_usd < BYBIT_MIN_MARGIN:
            logger.info(
                "AutoExec BYBIT: risk_usd=%.4f < floor %.2f — using floor",
                risk_usd, BYBIT_MIN_MARGIN,
            )
            risk_usd = BYBIT_MIN_MARGIN

        entry   = signal.entry_price
        sl      = signal.stop_loss
        tp      = signal.take_profit
        sl_dist = abs(entry - sl)
        if sl_dist == 0:
            logger.warning("AutoExec BYBIT: SL=entry for %s — skip", sym)
            sig_dict["exec_status"] = "failed"
            sig_dict["exec_error"]  = "SL equals entry price"
            return

        safe_lev = _compute_safe_leverage(entry, sl, leverage)
        qty_raw  = (risk_usd * safe_lev) / (sl_dist * entry)
        min_qty  = _MIN_ORDER_QTY.get(sym, 0.001)
        qty      = max(round(qty_raw, 3), min_qty)
        side     = "Buy" if signal.direction.value == "LONG" else "Sell"

        # Lock instrument BEFORE order — store sl/tp so exit monitor can watch it
        _trade_tracker.lock(sym, signal.direction.value, entry, "pending", sl=sl, tp=tp)

        result   = await bybit_place_market_order(
            api_key, api_secret, sym, side, str(qty), sl, tp, safe_lev, margin_type,
        )
        trade_id = result.get("result", {}).get("orderId", "")
        # Update lock with real orderId; sl/tp preserved from pending entry above
        _trade_tracker.lock(sym, signal.direction.value, entry, trade_id, sl=sl, tp=tp)

        # ── Write execution success back to sig_dict (frontend badge) ────
        sig_dict["exec_status"]   = "ok"
        sig_dict["exec_order_id"] = trade_id
        sig_dict["exec_qty"]      = qty
        sig_dict["exec_side"]     = side

        logger.info(
            "✅ BYBIT AUTO-EXEC: %s %s %s  qty=%.3f  lev=%d×  entry=%.4f  sl=%.4f  tp=%.4f",
            sym, side, margin_type, qty, safe_lev, entry, sl, tp,
        )
    except Exception as exc:
        err_msg = str(exc)
        logger.error("AutoExec BYBIT FAILED %s: %s", sym, err_msg)
        _trade_tracker.unlock(sym)   # release lock if order failed
        # ── Write failure back to sig_dict so history tab shows "FAILED" ─
        sig_dict["exec_status"] = "failed"
        sig_dict["exec_error"]  = err_msg



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
    """
    Send a push notification via OneSignal REST API.

    Triggered exclusively from the BACKEND (signal loops) so notifications
    fire even when the phone screen is off / app is backgrounded.

    Sound:   ios_sound='ding.wav', android_sound='ding' — place ding.wav in
             the iOS app bundle and ding.mp3 in res/raw for Android.
             Falls back to device default if the file is absent.
    Stacking: android_group + thread_id let multiple signals stack under one
             expandable notification rather than flooding the shade.
    """
    if not ONESIGNAL_APP_ID or not ONESIGNAL_REST_KEY:
        return
    if not _push_subscriptions:
        return
    instrument_key = data.get("instrument", data.get("symbol", "fx-radiant"))
    payload = {
        "app_id":                   ONESIGNAL_APP_ID,
        "include_subscription_ids": list(_push_subscriptions),
        "headings":                 {"en": title},
        "contents":                 {"en": body},
        "data":                     data,
        # ── Sound ──────────────────────────────────────────────────────────
        "ios_sound":                "ding.wav",
        "android_sound":            "ding",
        # ── Vibration ──────────────────────────────────────────────────────
        "android_vibrate":          True,
        # ── Stacking (group signals under one expandable notification) ─────
        "android_group":            "fx-radiant-signals",
        "android_group_message":    {"en": "$[notif_count] new FX Radiant signals"},
        "thread_id":                "fx-radiant-signals",   # iOS 12+ grouping
        "summary_arg":              "FX Radiant Signals",
        # ── Collapse identical instruments (replace, don't stack per-pair) ─
        "collapse_id":              instrument_key,
        # ── Background delivery ────────────────────────────────────────────
        # content_available=1 wakes iOS apps in background for silent pushes
        "content_available":        True,
        "priority":                 10,   # high delivery priority
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


async def _oanda_auto_execute(ins: str, sig_dict: dict, signal) -> None:
    """
    Hard-automate: place an Oanda market order for every 100% confluence signal.
    Uses OANDA_API_KEY / OANDA_ACCOUNT_ID from .env.
    Position sizing: risk_pct% of account NAV, SL as submitted stop.
    """
    if _trade_tracker.is_locked(ins):
        logger.info("AutoExec OANDA: %s already locked — skip", ins)
        return

    creds = _get_oanda_creds()
    if not creds:
        logger.warning("AutoExec OANDA: OANDA_API_KEY/ACCOUNT_ID not configured in .env")
        return

    api_key, account_id = creds

    try:
        summary  = await fetch_account_summary(api_key, account_id)
        # fetch_account_summary already unwraps resp.json()["account"],
        # so NAV is top-level — do NOT double-nest under ["account"]
        nav      = float(summary.get("NAV", 0) or 0)
        if nav <= 0:
            logger.warning(
                "AutoExec OANDA: zero NAV for %s — account keys: %s",
                ins, list(summary.keys())[:10],
            )
            return

        risk_pct = _get_bot_risk_pct()
        risk_usd = nav * risk_pct
        entry    = signal.entry_price
        sl       = signal.stop_loss
        tp       = signal.take_profit
        sl_dist  = abs(entry - sl)
        if sl_dist == 0:
            logger.warning("AutoExec OANDA: SL=entry for %s — skip", ins)
            return

        is_long = signal.direction.value == "LONG"
        units   = _oanda_compute_units(ins, risk_usd, sl_dist, is_long)
        if abs(units) < 1:
            logger.warning("AutoExec OANDA: computed units<1 for %s — skip", ins)
            return

        # Lock BEFORE order — store sl/tp so exit monitor can watch it
        _trade_tracker.lock(ins, signal.direction.value, entry, "pending", sl=sl, tp=tp)

        result   = await place_market_order(api_key, account_id, ins, units, sl, tp)
        fill_tx  = result.get("orderFillTransaction") or {}
        trade_id = (result.get("orderCreateTransaction") or fill_tx).get("id", "")

        if not fill_tx and result.get("orderCancelTransaction"):
            cancel_reason = result["orderCancelTransaction"].get("reason", "UNKNOWN")
            raise RuntimeError(f"Order cancelled by Oanda: {cancel_reason}")

        # Update lock with real tradeId; sl/tp preserved from pending entry above
        _trade_tracker.lock(ins, signal.direction.value, entry, trade_id, sl=sl, tp=tp)
        sig_dict["exec_status"]   = "ok"
        sig_dict["exec_order_id"] = trade_id
        sig_dict["exec_units"]    = units
        sig_dict["exec_fill_px"]  = float(fill_tx.get("price", entry))

        logger.info(
            "✅ OANDA AUTO-EXEC: %s %s  units=%d  entry=%.5f  sl=%.5f  tp=%.5f",
            ins, signal.direction.value, units, entry, sl, tp,
        )
    except Exception as exc:
        err_msg = str(exc)
        logger.error("AutoExec OANDA FAILED %s: %s", ins, err_msg)
        _trade_tracker.unlock(ins)
        sig_dict["exec_status"] = "failed"
        sig_dict["exec_error"]  = err_msg


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
                            # ── Signal deduplication: skip if instrument locked ────────
                            if _trade_tracker.is_locked(ins):
                                logger.debug("TradeTracker: SKIP %s — instrument locked", ins)
                            else:
                                _signal_history[ins] = ([sig_dict] + _signal_history[ins])[:50]
                                await broadcast(sig_dict)
                                logger.info("🟢 OANDA SIGNAL: %s %s  conf=%d%%", ins, signal.direction.value, signal.confidence)
                                if signal.confidence >= 95:
                                    asyncio.create_task(_send_onesignal_push(
                                        title = f"🚨 {ins.replace('_','/')} {signal.direction.value.title()} Setup",
                                        body  = (
                                            f"Entry {signal.entry_price:.5f}  ·  "
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
                                # ── Hard auto-execute at 100% confluence ───────────
                                if signal.confidence >= 100:
                                    asyncio.create_task(
                                        _oanda_auto_execute(ins, sig_dict, signal)
                                    )
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

# ─────────────────────────────────────────────────────────────────────────────
#  Trade Reconciliation Loop
#
#  Problem: TradeTracker locks an instrument the moment an order is placed.
#  If the order is rejected, partially filled, or manually closed outside the
#  bot, the lock remains and the bot never re-enters — a "ghost trade" bug.
#
#  Solution: Every 5 minutes, cross-reference locked instruments/symbols
#  against the LIVE open positions from Oanda and Bybit.  Any lock that
#  has no corresponding live position is automatically released so the SMC
#  engine can find a fresh setup on the next candle refresh.
# ─────────────────────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────────────────
#  Exit Monitor Loop  (TP / SL / 2-h TTL enforcement)
#
#  Why this exists:
#    Exchange-side TP/SL can be silently dropped after network blips, margin
#    mode changes, or API glitches.  This loop is the bot-side failsafe that
#    actively monitors every open position and closes it when:
#      • TP is hit  (LONG price >= tp  |  SHORT price <= tp)
#      • SL is hit  (LONG price <= sl  |  SHORT price >= sl)
#      • 2-h TTL expired  (opened_at + 7200 s has elapsed)
#
#  Sweep interval: every 30 seconds
#  Price source:   _bybit_prices (60s ticker) / _latest_prices (real-time SSE)
#
#  All exits logged as:
#    [EXIT] Closed BTCUSDT — TP hit (price 72150.00 >= tp 72000.00)
#    [EXIT] Closed EUR_USD — SL hit (price 1.07820 <= sl 1.07850)
#    [EXIT] Closed XAU_USD — TTL (2h expired; opened 7210s ago)
# ─────────────────────────────────────────────────────────────────────────────

EXIT_MONITOR_INTERVAL = 30    # seconds between sweeps


async def _exit_close_bybit(sym: str, lock: dict, reason: str) -> None:
    """Force-close a Bybit position via market order and release the TradeTracker lock."""
    creds = _get_bybit_creds()
    if not creds:
        logger.error("[EXIT] Bybit creds missing — cannot close %s (%s)", sym, reason)
        return
    api_key, api_secret = creds
    try:
        # Fetch live position to get exact current size and side
        positions = await bybit_fetch_positions(api_key, api_secret)
        pos = next((p for p in positions if p.get("symbol") == sym), None)
        if not pos:
            # Position already gone — exchange-side TP/SL fired first
            logger.info("[EXIT] %s already closed on exchange (%s)", sym, reason)
            _trade_tracker.unlock(sym)
            return
        size = str(pos.get("size", "0"))
        side = pos.get("side", "Buy")   # "Buy" = long position open
        await close_bybit_position(api_key, api_secret, sym, side, size)
        _trade_tracker.unlock(sym)
        logger.info("[EXIT] Closed %s — %s  size=%s", sym, reason, size)
    except Exception as exc:
        logger.error("[EXIT] Failed to close Bybit %s (%s): %s", sym, reason, exc)


async def _exit_close_oanda(ins: str, lock: dict, reason: str) -> None:
    """Force-close an Oanda trade by ID and release the TradeTracker lock."""
    creds = _get_oanda_creds()
    if not creds:
        logger.error("[EXIT] Oanda creds missing — cannot close %s (%s)", ins, reason)
        return
    api_key, account_id = creds
    trade_id = lock.get("trade_id", "")
    try:
        if trade_id and trade_id != "pending":
            # Primary path: use the stored numeric trade ID for precise close
            await close_oanda_trade(api_key, account_id, trade_id)
            _trade_tracker.unlock(ins)
            logger.info("[EXIT] Closed %s — %s  trade_id=%s", ins, reason, trade_id)
        else:
            # Fallback: scan open trades and find by instrument name
            trades    = await fetch_open_trades(api_key, account_id)
            matching  = [t for t in trades if t.get("instrument") == ins]
            if not matching:
                logger.info("[EXIT] %s already closed on exchange (%s)", ins, reason)
                _trade_tracker.unlock(ins)
                return
            for t in matching:
                tid = str(t.get("id", ""))
                if tid:
                    await close_oanda_trade(api_key, account_id, tid)
                    logger.info(
                        "[EXIT] Closed %s — %s  trade_id=%s (fallback scan)",
                        ins, reason, tid,
                    )
            _trade_tracker.unlock(ins)
    except Exception as exc:
        logger.error("[EXIT] Failed to close Oanda %s (%s): %s", ins, reason, exc)


async def exit_monitor_loop() -> None:
    """
    Background watcher — sweeps every 30 seconds.

    For every active TradeTracker lock it evaluates (in priority order):
      1. Hard TTL  — opened_at + 2h elapsed → force market close regardless of PnL
      2. TP hit    — LONG:  price >= tp  |  SHORT: price <= tp
      3. SL hit    — LONG:  price <= sl  |  SHORT: price >= sl

    Price data sources:
      • Bybit  → _bybit_prices  (updated every 60s by bybit_refresh_loop)
      • Oanda  → _latest_prices (updated in real-time by price_stream_loop SSE)
    """
    await asyncio.sleep(20)   # brief startup delay — let price streams warm up

    while True:
        try:
            locks = _trade_tracker.all_locks()
            now   = time.time()

            for symbol, lock in list(locks.items()):
                direction = lock.get("direction", "LONG")
                sl        = float(lock.get("sl",       0) or 0)
                tp        = float(lock.get("tp",       0) or 0)
                opened_at = float(lock.get("opened_at", now) or now)
                is_bybit  = symbol.endswith("USDT")

                # ── Resolve live price ──────────────────────────────────────
                price = (_bybit_prices if is_bybit else _latest_prices).get(symbol, 0.0)
                if price <= 0:
                    continue   # price not yet populated — skip this tick

                # ── 1. Hard 2-hour TTL ──────────────────────────────────────
                age_s = now - opened_at
                if age_s >= TRADE_LOCK_TTL_SECONDS:
                    reason = f"TTL (2h expired; opened {int(age_s)}s ago)"
                    logger.warning(
                        "[EXIT] %s — TTL triggered  age=%ds  price=%.5f",
                        symbol, int(age_s), price,
                    )
                    if is_bybit:
                        await _exit_close_bybit(symbol, lock, reason)
                    else:
                        await _exit_close_oanda(symbol, lock, reason)
                    continue   # skip TP/SL checks after TTL close

                # ── 2. Take-Profit check ────────────────────────────────────
                if tp > 0:
                    tp_hit = (direction == "LONG"  and price >= tp) or                              (direction == "SHORT" and price <= tp)
                    if tp_hit:
                        cmp    = ">=" if direction == "LONG" else "<="
                        reason = f"TP hit (price {price:.5f} {cmp} tp {tp:.5f})"
                        logger.info(
                            "[EXIT] %s — TP triggered  price=%.5f  tp=%.5f  dir=%s",
                            symbol, price, tp, direction,
                        )
                        if is_bybit:
                            await _exit_close_bybit(symbol, lock, reason)
                        else:
                            await _exit_close_oanda(symbol, lock, reason)
                        continue

                # ── 3. Stop-Loss check ──────────────────────────────────────
                if sl > 0:
                    sl_hit = (direction == "LONG"  and price <= sl) or                              (direction == "SHORT" and price >= sl)
                    if sl_hit:
                        cmp    = "<=" if direction == "LONG" else ">="
                        reason = f"SL hit (price {price:.5f} {cmp} sl {sl:.5f})"
                        logger.info(
                            "[EXIT] %s — SL triggered  price=%.5f  sl=%.5f  dir=%s",
                            symbol, price, sl, direction,
                        )
                        if is_bybit:
                            await _exit_close_bybit(symbol, lock, reason)
                        else:
                            await _exit_close_oanda(symbol, lock, reason)

        except Exception as loop_exc:
            logger.error("exit_monitor_loop error: %s", loop_exc)

        await asyncio.sleep(EXIT_MONITOR_INTERVAL)


async def trade_reconciliation_loop() -> None:
    """
    Periodically reconcile TradeTracker locks with live broker positions.
    Runs every 5 minutes.  If a locked instrument has no live open position,
    the lock is released ('ghost trade' fix).
    """
    RECON_INTERVAL = 300   # 5 minutes
    await asyncio.sleep(60)  # initial delay — let signal loops start first

    while True:
        try:
            locks = _trade_tracker.all_locks()
            if not locks:
                await asyncio.sleep(RECON_INTERVAL)
                continue

            # ── Oanda reconciliation ─────────────────────────────────────
            oanda_creds = _get_oanda_creds()
            if oanda_creds:
                try:
                    live_trades   = await fetch_open_trades(*oanda_creds)
                    live_oanda    = {t.get("instrument", "") for t in live_trades}
                    oanda_locked  = [s for s in locks if "_" in s and not s.endswith("USDT")]
                    for ins in oanda_locked:
                        if ins not in live_oanda:
                            _trade_tracker.unlock(ins)
                            logger.warning(
                                "🔓 Reconciliation: Oanda lock RELEASED for %s "
                                "(no live position found — ghost trade removed)",
                                ins,
                            )
                except Exception as exc:
                    logger.debug("Reconciliation Oanda probe failed: %s", exc)

            # ── Bybit reconciliation ─────────────────────────────────────
            bybit_creds = _get_bybit_creds()
            if bybit_creds:
                try:
                    live_positions = await bybit_fetch_positions(*bybit_creds)
                    live_bybit     = {p.get("symbol", "") for p in live_positions}
                    bybit_locked   = [s for s in locks if s.endswith("USDT")]
                    for sym in bybit_locked:
                        if sym not in live_bybit:
                            _trade_tracker.unlock(sym)
                            logger.warning(
                                "🔓 Reconciliation: Bybit lock RELEASED for %s "
                                "(no live position found — ghost trade removed)",
                                sym,
                            )
                except Exception as exc:
                    logger.debug("Reconciliation Bybit probe failed: %s", exc)

        except Exception as loop_exc:
            logger.error("trade_reconciliation_loop error: %s", loop_exc)

        await asyncio.sleep(RECON_INTERVAL)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("━" * 60)
    logger.info("  FX Radiant v3.0 — Private Bot Mode  🤖")
    logger.info("  Elite 35: %d Oanda + %d Bybit instruments", len(INSTRUMENTS), len(BYBIT_SYMBOLS))
    await _fetch_clerk_jwks()

    logger.info("  OANDA_API_KEY     : %s",
                "✅ set" if os.environ.get("OANDA_API_KEY",    "").strip() else "❌ MISSING")
    logger.info("  OANDA_ACCOUNT_ID  : %s",
                "✅ set" if os.environ.get("OANDA_ACCOUNT_ID", "").strip() else "❌ MISSING")
    logger.info("  BYBIT_API_KEY     : %s",
                "✅ set" if BYBIT_API_KEY else "❌ MISSING — Bybit orders won't execute")
    logger.info("  BYBIT_API_SECRET  : %s",
                "✅ set" if BYBIT_API_SECRET else "❌ MISSING — Bybit orders won't execute")
    logger.info("  BOT_RISK_PCT      : %s%%",
                os.environ.get("BOT_RISK_PCT", "10.0"))
    logger.info("  BYBIT_LEVERAGE    : %d×  (%s margin)",
                BYBIT_DEFAULT_LEVERAGE, BYBIT_MARGIN_TYPE)
    logger.info("  Clerk keys cached : %d", len(_clerk_jwks))
    logger.info("━" * 60)

    # ── Startup NAV probe — logs Oanda account balance for .env validation ──
    _oanda_creds = _get_oanda_creds()
    if _oanda_creds:
        try:
            _acct = await asyncio.wait_for(
                fetch_account_summary(*_oanda_creds), timeout=10.0,
            )
            _nav = float(_acct.get("NAV", 0) or 0)
            logger.info(
                "Oanda startup probe — NAV=%.2f  balance=%.2f  openTrades=%s  id=%s  env_account=%s",
                _nav,
                float(_acct.get("balance", 0) or 0),
                _acct.get("openTradeCount", "?"),
                _acct.get("id", "?"),
                os.getenv("OANDA_ACCOUNT_ID", "NOT_SET"),
            )
            if _nav <= 0:
                logger.warning(
                    "⚠️  Oanda NAV=0 — full account_details keys: %s | "
                    "Check that OANDA_ACCOUNT_ID matches your broker environment "
                    "(practice vs live). Full dump: %s",
                    list(_acct.keys()),
                    {k: v for k, v in _acct.items() if k in (
                        "id", "currency", "balance", "NAV", "unrealizedPL",
                        "marginUsed", "marginAvailable", "positionValue",
                    )},
                )
        except Exception as _exc:
            logger.warning("Oanda startup probe FAILED: %s — check OANDA_ACCOUNT_ID environment", _exc)
    else:
        logger.info("Oanda startup probe: skipped (OANDA_API_KEY / OANDA_ACCOUNT_ID not set)")

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
    asyncio.create_task(exit_monitor_loop())          # TP/SL/TTL watcher (30s sweep)
    asyncio.create_task(trade_reconciliation_loop())  # ghost-trade cleanup (5 min)
    yield


# ─────────────────────────────────────────────────────────────────────────────
#  FastAPI app + CORS + global error handler
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="FX Radiant API",
    version="3.0.0",
    description="FX Radiant — Private Bot Mode, Elite 35, Hard Auto-Execute",
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

# OandaCredentialsRequest / BybitCredentialsRequest removed — env-only mode

class PushRegisterRequest(BaseModel):
    player_id: str


# BybitSettingsRequest / UserSettingsRequest removed — env-only mode


# ─────────────────────────────────────────────────────────────────────────────
#  Auth / user routes
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/auth/me")
async def me(payload: dict = Depends(get_current_user)):
    """Bot status endpoint — credentials are managed via .env."""
    return {
        "bot_mode":          "PRIVATE",
        "oanda_connected":   bool(_get_oanda_creds()),
        "bybit_connected":   bool(_get_bybit_creds()),
        "oanda_instruments": len(INSTRUMENTS),
        "bybit_symbols":     len(BYBIT_SYMBOLS),
        "trade_locks":       len(_trade_tracker.all_locks()),
        "clerk_id":          payload["sub"],
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





@app.get("/api/bybit/trade-locks")
async def get_trade_locks(_: dict = Depends(get_current_user)):
    """
    Return currently locked symbols with enriched TTL info.
    Used by the frontend to show lock badges and TTL countdowns on signal cards.
    """
    now   = time.time()
    locks = _trade_tracker.all_locks()
    enriched = {}
    for sym, lock in locks.items():
        opened  = float(lock.get("opened_at", now))
        expires = float(lock.get("expires_at", now + TRADE_LOCK_TTL_SECONDS))
        enriched[sym] = {
            **lock,
            "age_seconds":        int(now - opened),
            "ttl_remaining_s":    max(0, int(expires - now)),
            "ttl_pct":            round(min(100, (now - opened) / TRADE_LOCK_TTL_SECONDS * 100), 1),
        }
    return enriched


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

    On auth failure (retCode 10004) returns structured JSON with hint rather than
    crashing the route — prevents the frontend from showing a raw 503 error.
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
    except RuntimeError as exc:
        # Clean JSON 503 — includes Bybit retCode and hint from _bybit_raise_on_error
        raise HTTPException(503, detail={"error": "Bybit API Unavailable", "detail": str(exc)})
    except Exception as exc:
        raise HTTPException(503, detail={"error": "Bybit API Unavailable", "detail": str(exc)})


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
    except RuntimeError as exc:
        raise HTTPException(503, detail={"error": "Bybit API Unavailable", "detail": str(exc)})
    except Exception as exc:
        raise HTTPException(503, detail={"error": "Bybit API Unavailable", "detail": str(exc)})


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
    except RuntimeError as exc:
        raise HTTPException(503, detail={"error": "Bybit API Unavailable", "detail": str(exc)})
    except Exception as exc:
        raise HTTPException(503, detail={"error": "Bybit API Unavailable", "detail": str(exc)})


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
#  Manual Trade Close  — Oanda + Bybit
# ─────────────────────────────────────────────────────────────────────────────

class TradeCloseRequest(BaseModel):
    # For Oanda
    trade_id:   Optional[str] = None   # Oanda trade ID (string)
    # For Bybit
    symbol:     Optional[str] = None   # e.g. "BTCUSDT"
    side:       Optional[str] = None   # current position side: "Buy" | "Sell"
    qty:        Optional[str] = None   # position size as string, e.g. "0.001"
    # Routing
    broker:     str = "oanda"          # "oanda" | "bybit"


@app.post("/api/trade/close")
async def close_trade(body: TradeCloseRequest, payload: dict = Depends(get_current_user)):
    """
    Manually close a trade/position.

    Oanda: PUT /v3/accounts/{id}/trades/{trade_id}/close  (units=ALL)
    Bybit: POST /v5/order/create  (reduceOnly=True, opposite side)

    On success: releases TradeTracker lock for the instrument/symbol.
    Returns 400/500 on failure — never silently swallows errors.
    """
    broker = (body.broker or "oanda").lower()

    if broker == "bybit":
        if not body.symbol or not body.side or not body.qty:
            raise HTTPException(422, "symbol, side, and qty are required for Bybit close")
        creds = _get_bybit_creds()
        if not creds:
            raise HTTPException(503, "BYBIT_API_KEY/SECRET not configured in .env")
        api_key, api_secret = creds
        try:
            result = await close_bybit_position(api_key, api_secret, body.symbol, body.side, body.qty)
            # Release trade lock so the engine can find new setups
            _trade_tracker.unlock(body.symbol)
            logger.info("🔓 Manual close: Bybit %s — lock released", body.symbol)
            return {
                "ok":     True,
                "broker": "bybit",
                "symbol": body.symbol,
                "result": result.get("result", {}),
            }
        except Exception as exc:
            logger.error("Manual close BYBIT %s failed: %s", body.symbol, exc)
            raise HTTPException(503, f"Bybit close failed: {exc}")

    else:  # oanda
        if not body.trade_id:
            raise HTTPException(422, "trade_id is required for Oanda close")
        creds = _get_oanda_creds()
        if not creds:
            raise HTTPException(503, "OANDA_API_KEY/ACCOUNT_ID not configured in .env")
        api_key, account_id = creds
        try:
            result     = await close_oanda_trade(api_key, account_id, body.trade_id)
            fill_tx    = result.get("orderFillTransaction") or {}
            instrument = fill_tx.get("instrument", "")
            # Release trade lock for this instrument
            if instrument:
                _trade_tracker.unlock(instrument)
                logger.info("🔓 Manual close: Oanda %s — lock released", instrument)
            return {
                "ok":         True,
                "broker":     "oanda",
                "trade_id":   body.trade_id,
                "instrument": instrument,
                "realized_pl": fill_tx.get("pl", "0"),
            }
        except Exception as exc:
            logger.error("Manual close OANDA %s failed: %s", body.trade_id, exc)
            raise HTTPException(503, f"Oanda close failed: {exc}")




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
#  Bot Settings  (live runtime update — persisted to settings.json)
# ─────────────────────────────────────────────────────────────────────────────

class BotSettingsRequest(BaseModel):
    risk_pct: float | None = None   # 1.0 – 20.0


@app.get("/api/settings")
async def get_bot_settings(payload: dict = Depends(get_current_user)):
    """
    Return current bot settings.  Frontend calls this on every page load
    to guarantee the UI always reflects the actual backend value —
    preventing the '1% vs 10%' stale-state bug where React resets the
    slider to its initial state value after navigation.
    """
    return {
        "risk_pct":          _effective_risk_pct_display(),
        "rr_ratio":          3.0,
        "bybit_leverage":    BYBIT_DEFAULT_LEVERAGE,
        "bybit_margin_type": BYBIT_MARGIN_TYPE,
        "source":            "settings.json" if _runtime_risk_pct >= 0 else "env",
    }


@app.post("/api/settings/update")
async def update_bot_settings(
    body: BotSettingsRequest,
    _: dict = Depends(get_current_user),
):
    """
    Update bot execution parameters at runtime without restart.
    Changes are immediately written to settings.json so they survive
    a server restart or process recycle.
    """
    global _runtime_risk_pct
    clerk_id = payload.get("sub", "default")
    changed  = {}
    if body.risk_pct is not None:
        clamped = max(1.0, min(20.0, float(body.risk_pct)))
        _runtime_risk_pct = clamped
        changed["risk_pct"] = clamped
        existing = _load_settings(clerk_id)
        existing["risk_pct"] = clamped
        _save_settings(existing, clerk_id)
        logger.info("Bot risk updated for %s -> %.1f%%", clerk_id[:8], clamped)
    return {
        "ok":       True,
        "changed":  changed,
        "risk_pct": _effective_risk_pct_display(),
        "source":   "user_settings",
    }


# ─────────────────────────────────────────────────────────────────────────────
#  Health
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status":               "ok",
        "version":              "3.1.0",
        "auth":                 "clerk",
        "jwks_keys":            len(_clerk_jwks),
        "ws_clients":           len(_ws_clients),
        "oanda_prices_cached":  len(_latest_prices),
        "bybit_prices_cached":  sum(1 for p in _bybit_prices.values() if p > 0),
        "bybit_signals_total":  sum(len(v) for v in _bybit_signal_history.values()),
        "trade_locks":          len(_trade_tracker.all_locks()),
        "oanda_executor":       "READY" if _get_oanda_creds() else "NO_CREDS",
        "bybit_executor":       "READY" if _get_bybit_creds() else "NO_CREDS",
        "effective_risk_pct":   _effective_risk_pct_display(),
        "settings_source":      "settings.json" if _runtime_risk_pct >= 0 else "env",
        "exit_monitor":         f"active (30s sweep, TTL={TRADE_LOCK_TTL_SECONDS//60}m)",
        "timestamp":            int(time.time()),
    }