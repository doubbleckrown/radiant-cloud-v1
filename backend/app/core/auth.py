"""
app/core/auth.py — Clerk RS256 JWT verification + FastAPI dependency.
"""
from __future__ import annotations
import logging
from typing import Any

import jwt as _jwt
import httpx
from fastapi import Depends, HTTPException, Request, status

from app.core.config import CLERK_JWKS_URL

logger = logging.getLogger("fx-signal")

_clerk_jwks: dict[str, Any] = {}


async def fetch_clerk_jwks() -> None:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(CLERK_JWKS_URL)
            resp.raise_for_status()
        keys: dict[str, Any] = {}
        for kd in resp.json().get("keys", []):
            kid = kd.get("kid")
            if kid:
                keys[kid] = _jwt.algorithms.RSAAlgorithm.from_jwk(kd)
        _clerk_jwks.update(keys)
        logger.info("Clerk JWKS: loaded %d key(s)", len(keys))
    except Exception as exc:
        logger.error("Could not load Clerk JWKS: %s", exc)


async def verify_clerk_token(raw_token: str) -> dict:
    if not raw_token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing token")
    try:
        header = _jwt.get_unverified_header(raw_token)
        kid    = header.get("kid")
        pub    = _clerk_jwks.get(kid)
        if pub is None:
            await fetch_clerk_jwks()
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
    if not payload.get("sub"):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "No user ID in token")
    return payload


async def get_current_user(request: Request) -> dict:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing Authorization header")
    return await verify_clerk_token(auth.split(" ", 1)[1].strip())
