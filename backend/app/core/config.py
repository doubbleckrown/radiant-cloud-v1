"""
app/core/config.py — Single source of truth for all constants and env bindings.
"""
from __future__ import annotations
import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    _env_path = Path(__file__).resolve().parents[3] / ".env"
    load_dotenv(_env_path, override=False)
except ImportError:
    pass

OANDA_API_KEY  = os.getenv("OANDA_API_KEY",   "")
OANDA_ACCOUNT  = os.getenv("OANDA_ACCOUNT_ID", "")
OANDA_BASE     = os.getenv("OANDA_BASE_URL",   "https://api-fxpractice.oanda.com")
OANDA_STREAM   = os.getenv("OANDA_STREAM_URL", "https://stream-fxpractice.oanda.com")

INSTRUMENTS: list[str] = [
    "EUR_USD","GBP_USD","USD_JPY","AUD_USD","NZD_USD",
    "USD_CAD","EUR_GBP","GBP_JPY","EUR_JPY","AUD_CAD",
    "XAU_USD","XAG_USD","XPT_USD",
    "NAS100_USD","SPX500_USD","US30_USD",
]
GRANULARITIES: list[str] = ["M1", "M5", "M15", "H1"]
OANDA_MIN_UNITS: dict[str, int] = {
    "XAU_USD":1,"XAG_USD":1,"XPT_USD":1,
    "NAS100_USD":1,"SPX500_USD":1,"US30_USD":1,
}
OANDA_SL_DECIMALS: dict[str, int] = {
    "XAU_USD":3,"XAG_USD":3,"XPT_USD":3,
    "NAS100_USD":1,"SPX500_USD":1,"US30_USD":1,
}

BYBIT_BASE           = "https://api.bybit.com"
BYBIT_API_KEY        = os.getenv("BYBIT_API_KEY",    "")
BYBIT_API_SECRET     = os.getenv("BYBIT_API_SECRET", "")
BYBIT_DEFAULT_LEVERAGE = int(os.getenv("BYBIT_DEFAULT_LEVERAGE", "20"))
BYBIT_MARGIN_TYPE    = os.getenv("BYBIT_MARGIN_TYPE", "ISOLATED")
BYBIT_RECV_WINDOW    = "5000"
BYBIT_QTY_STEP = 0.1

BYBIT_SYMBOLS: list[str] = [
    "BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","BNBUSDT",
    "DOGEUSDT","AVAXUSDT","ADAUSDT","DOTUSDT","LINKUSDT",
    "LTCUSDT","NEARUSDT","ATOMUSDT","UNIUSDT",
    "1000PEPEUSDT","1000BONKUSDT","FARTCOINUSDT","XPLUSDT","WLFIUSDT",
]
BYBIT_MIN_ORDER_QTY: dict[str, float] = {
    "BTCUSDT":0.001,"ETHUSDT":0.01,"SOLUSDT":0.1,"XRPUSDT":10.0,
    "BNBUSDT":0.01,"DOGEUSDT":100.0,"AVAXUSDT":0.1,"ADAUSDT":10.0,
    "DOTUSDT":1.0,"LINKUSDT":1.0,"LTCUSDT":0.1,"NEARUSDT":1.0,
    "ATOMUSDT":1.0,"UNIUSDT":1.0,
    "1000PEPEUSDT":100.0,"1000BONKUSDT":100.0,"FARTCOINUSDT":1.0,
    "XPLUSDT":1.0,"WLFIUSDT":10.0,
}
BYBIT_INTERVALS: list[str] = ["60", "15", "5", "1"]

CLERK_JWKS_URL = os.getenv("CLERK_JWKS_URL","https://immune-donkey-10.clerk.accounts.dev/.well-known/jwks.json")
ONESIGNAL_APP_ID   = os.getenv("ONESIGNAL_APP_ID",  "")
ONESIGNAL_REST_KEY = os.getenv("ONESIGNAL_REST_KEY", "")
TRADE_LOCK_TTL_SECONDS = 7200
EXIT_MONITOR_INTERVAL  = 30
BOT_RISK_PCT = float(os.getenv("BOT_RISK_PCT", "10.0"))

def get_oanda_creds() -> tuple[str, str] | None:
    k = os.environ.get("OANDA_API_KEY","").strip()
    a = os.environ.get("OANDA_ACCOUNT_ID","").strip()
    return (k, a) if (k and a) else None

def get_bybit_creds() -> tuple[str, str] | None:
    k = os.environ.get("BYBIT_API_KEY","").strip()
    s = os.environ.get("BYBIT_API_SECRET","").strip()
    return (k, s) if (k and s) else None
