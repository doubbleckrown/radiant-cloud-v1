"""
FX Radiant — User Models
==========================
Pydantic models (schemas) for everything user-related.

These are NOT database table definitions — they are data-validation
shapes used for:
  • Validating incoming request bodies
  • Shaping outgoing response bodies
  • Type-safe data transfer between functions

Three distinct shapes:
  UserCreate      → what the frontend sends when signing up
  UserLogin       → what the frontend sends when logging in
  UserPublic      → what we safely send back (NO password field!)
  UserInDB        → the full internal record stored in users_db
  TokenResponse   → the JWT pair returned after auth
  RefreshRequest  → the body sent when refreshing an access token
"""

from __future__ import annotations
from pydantic import BaseModel, EmailStr, Field, field_validator


# ── Inbound schemas (requests) ────────────────────────────────────────────────

class UserCreate(BaseModel):
    """Sent by the frontend on the Sign Up form."""
    email:    EmailStr
    password: str = Field(min_length=8, description="Minimum 8 characters")
    name:     str = Field(min_length=1, max_length=80)

    @field_validator("password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        if v.isdigit():
            raise ValueError("Password must contain at least one letter")
        return v


class RefreshRequest(BaseModel):
    """Sent by the frontend when the access token has expired."""
    refresh_token: str


# ── Outbound schemas (responses) ──────────────────────────────────────────────

class UserPublic(BaseModel):
    """
    Safe public representation of a user.
    NEVER include the password hash in this model.
    """
    email: EmailStr
    name:  str


class TokenResponse(BaseModel):
    """Returned after a successful login or signup."""
    access_token:  str
    refresh_token: str
    token_type:    str = "bearer"
    user:          UserPublic


class AccessTokenResponse(BaseModel):
    """Returned after a successful token refresh."""
    access_token: str
    token_type:   str = "bearer"


# ── Internal schema (NOT sent over the API) ───────────────────────────────────

class UserInDB(BaseModel):
    """
    The full user record as stored in users_db (or a real database row).
    Contains the bcrypt password hash — never expose this to the frontend.
    """
    email:    str
    name:     str
    password: str   # bcrypt hash, never the plain-text password

    def to_public(self) -> UserPublic:
        return UserPublic(email=self.email, name=self.name)