"""
FX Radiant — Core Configuration
================================
All environment variables are read from your .env file through
Pydantic's BaseSettings. Every other file imports from here —
this is the single source of truth for all configuration values.

Usage in any file:
    from app.core.config import settings
    print(settings.OANDA_API_KEY)
"""

from __future__ import annotations
from functools import lru_cache
from typing import List
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    All values are read automatically from your .env file.
    If a value is missing from .env, the default shown here is used.
    """

    # ── Application ───────────────────────────────────────────────────────
    APP_NAME:    str = "FX Radiant"
    APP_VERSION: str = "1.0.0"
    DEBUG:       bool = False

    # ── Security / JWT ────────────────────────────────────────────────────
    SECRET_KEY:  str = "change-this-to-a-long-random-secret-in-production"
    ALGORITHM:   str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES:  int = 30
    REFRESH_TOKEN_EXPIRE_DAYS:    int = 7

    # ── Oanda v20 API ─────────────────────────────────────────────────────
    OANDA_API_KEY:    str = ""
    OANDA_ACCOUNT_ID: str = ""
    OANDA_BASE_URL:   str = "https://api-fxpractice.oanda.com"
    OANDA_STREAM_URL: str = "https://stream-fxpractice.oanda.com"

    # ── Trading instruments ───────────────────────────────────────────────
    INSTRUMENTS: List[str] = [
        "EUR_USD",
        "GBP_USD",
        "USD_JPY",
        "XAU_USD",
        "NAS100_USD",
    ]
    GRANULARITIES: List[str] = ["M5", "M15", "H1"]

    # ── SMC Engine defaults ───────────────────────────────────────────────
    EMA_PERIOD:           int   = 200
    EMA_HYSTERESIS_PCT:   float = 0.0001   # 0.01% dead-zone
    SWING_LOOKBACK:       int   = 5
    DEFAULT_RR_RATIO:     float = 2.0
    SL_BUFFER_PCT:        float = 0.0002   # 0.02% beyond swing
    OB_LOOKBACK:          int   = 50
    FVG_LOOKBACK:         int   = 50

    # ── CORS ──────────────────────────────────────────────────────────────
    # Stored as a plain comma-separated string to avoid pydantic-settings
    # List parsing issues with .env files.
    # main.py uses ["*"] for development so this is a production reference.
    CORS_ORIGINS_STR: str = "http://localhost:5173,http://localhost:4173,http://127.0.0.1:5173"

    # ── Pydantic Settings config ──────────────────────────────────────────
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    def get_cors_origins(self) -> List[str]:
        """Parse the comma-separated CORS_ORIGINS_STR into a list."""
        return [o.strip() for o in self.CORS_ORIGINS_STR.split(",") if o.strip()]


@lru_cache()
def get_settings() -> Settings:
    """
    Returns a cached singleton of Settings.
    Use this function everywhere instead of creating Settings() directly.
    The @lru_cache means the .env file is only read once on startup.
    """
    return Settings()


# Convenience singleton — import this in other files:
#   from app.core.config import settings
settings = get_settings()