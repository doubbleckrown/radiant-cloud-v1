"""
FX Radiant — Auth Router
==========================
Handles all authentication endpoints:

    POST  /api/auth/signup    → Create a new account
    POST  /api/auth/login     → Login, receive JWT pair
    POST  /api/auth/refresh   → Get a new access token
    GET   /api/auth/me        → Return the logged-in user's profile

All business logic (hashing, JWT creation) lives in app.core.security.
This file only handles HTTP routing and request/response shaping.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm

from app.core.database import users_db
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    get_current_user,
    hash_password,
    verify_password,
)
from app.models.user import (
    AccessTokenResponse,
    RefreshRequest,
    TokenResponse,
    UserCreate,
    UserInDB,
    UserPublic,
)

router = APIRouter(prefix="/auth", tags=["Authentication"])


# ── Sign Up ───────────────────────────────────────────────────────────────────

@router.post(
    "/signup",
    response_model=TokenResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new trader account",
)
async def signup(body: UserCreate) -> TokenResponse:
    """
    Register a new user. Returns a JWT access + refresh token pair
    immediately so the user lands on the Markets page without a
    separate login step.

    Raises 400 if the email address is already registered.
    """
    if body.email in users_db:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="An account with this email already exists",
        )

    # Store user with hashed password — NEVER store plain text
    new_user = UserInDB(
        email=body.email,
        name=body.name,
        password=hash_password(body.password),
    )
    users_db[body.email] = new_user.model_dump()

    return TokenResponse(
        access_token=create_access_token(body.email),
        refresh_token=create_refresh_token(body.email),
        user=UserPublic(email=body.email, name=body.name),
    )


# ── Login ─────────────────────────────────────────────────────────────────────

@router.post(
    "/login",
    response_model=TokenResponse,
    summary="Login with email and password",
)
async def login(form: OAuth2PasswordRequestForm = Depends()) -> TokenResponse:
    """
    Standard OAuth2 password flow.
    The frontend sends the form fields 'username' (= email) and 'password'.

    Returns a JWT access + refresh token pair on success.
    Raises 401 if credentials are wrong — intentionally vague to prevent
    user enumeration attacks.
    """
    user = users_db.get(form.username)
    if not user or not verify_password(form.password, user["password"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return TokenResponse(
        access_token=create_access_token(form.username),
        refresh_token=create_refresh_token(form.username),
        user=UserPublic(email=user["email"], name=user["name"]),
    )


# ── Refresh token ─────────────────────────────────────────────────────────────

@router.post(
    "/refresh",
    response_model=AccessTokenResponse,
    summary="Get a new access token using a refresh token",
)
async def refresh(body: RefreshRequest) -> AccessTokenResponse:
    """
    Called automatically by the frontend when an access token expires.
    The refresh token has a 7-day lifetime.

    Returns only a new access token — the refresh token stays the same.
    """
    payload = decode_token(body.refresh_token, expected_type="refresh")
    email: str = payload["sub"]

    if email not in users_db:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )

    return AccessTokenResponse(access_token=create_access_token(email))


# ── Current user profile ──────────────────────────────────────────────────────

@router.get(
    "/me",
    response_model=UserPublic,
    summary="Get the currently logged-in user's profile",
)
async def me(current_user: dict = Depends(get_current_user)) -> UserPublic:
    """
    Returns the authenticated user's public profile.
    Used by the frontend on app startup to confirm the stored token
    is still valid and to display the user's name.
    """
    return UserPublic(
        email=current_user["email"],
        name=current_user["name"],
    )