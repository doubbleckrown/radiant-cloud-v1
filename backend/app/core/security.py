"""
FX Radiant — Security Utilities
=================================
All JWT and password logic lives here so it can be shared between
the auth router and any WebSocket authentication.

Exports:
    hash_password(plain)        → hashed string
    verify_password(plain, hash)→ bool
    create_access_token(email)  → JWT string
    create_refresh_token(email) → JWT string
    decode_token(token)         → payload dict  (raises HTTPException on failure)
    get_current_user(token)     → user dict     (FastAPI Depends-compatible)
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import settings

# ── Password hashing ──────────────────────────────────────────────────────────
_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(plain: str) -> str:
    """Return a bcrypt hash of the plain-text password."""
    return _pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    """Return True if plain matches the hashed password."""
    return _pwd_context.verify(plain, hashed)


# ── Token creation ────────────────────────────────────────────────────────────

def _create_token(data: dict[str, Any], expires_delta: timedelta) -> str:
    """Internal helper — builds and signs a JWT with an expiry."""
    payload = data.copy()
    payload["exp"] = datetime.now(timezone.utc) + expires_delta
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_access_token(email: str) -> str:
    """Short-lived token used in every API request header."""
    return _create_token(
        {"sub": email, "type": "access"},
        timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES),
    )


def create_refresh_token(email: str) -> str:
    """Long-lived token used only to request a new access token."""
    return _create_token(
        {"sub": email, "type": "refresh"},
        timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
    )


# ── Token verification ────────────────────────────────────────────────────────

def decode_token(token: str, expected_type: str = "access") -> dict:
    """
    Decode and validate a JWT.
    Raises HTTP 401 if the token is invalid, expired, or the wrong type.
    Returns the full decoded payload dict on success.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
    except JWTError:
        raise credentials_exception

    if payload.get("sub") is None:
        raise credentials_exception
    if payload.get("type") != expected_type:
        raise credentials_exception

    return payload


# ── FastAPI dependency ────────────────────────────────────────────────────────

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    """
    FastAPI dependency — inject into any route that requires authentication.

    Usage:
        @router.get("/protected")
        def protected_route(user: dict = Depends(get_current_user)):
            return {"email": user["email"]}

    Raises HTTP 401 if the token is missing, invalid, or the user no longer
    exists in the database.
    """
    # Avoid circular import — import the db store lazily
    from app.core.database import users_db

    payload = decode_token(token, expected_type="access")
    email: str = payload["sub"]

    user = users_db.get(email)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account not found",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


# ── WebSocket token check ─────────────────────────────────────────────────────

def verify_ws_token(token: str) -> dict | None:
    """
    Lightweight version for WebSocket handshake.
    Returns the payload dict if valid, or None if invalid (so the WS
    handler can close the connection cleanly without raising an exception).
    """
    try:
        return decode_token(token, expected_type="access")
    except HTTPException:
        return None