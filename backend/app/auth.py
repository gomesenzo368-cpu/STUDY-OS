import os
from dataclasses import dataclass, field
from pathlib import Path

import httpx
from fastapi import Header, HTTPException, status


@dataclass(frozen=True)
class AuthenticatedUser:
    user_id: str
    access_token: str = field(repr=False)


def local_env_value(name: str) -> str:
    value = os.getenv(name, "")
    if value:
        return value
    env_file = Path(__file__).resolve().parents[2] / "frontend" / ".env.local"
    if not env_file.exists():
        return ""
    for line in env_file.read_text(encoding="utf-8").splitlines():
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip().strip('"\'')
    return ""


def _verify_supabase_session(authorization: str | None) -> AuthenticatedUser:
    scheme, separator, access_token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not separator or not access_token.strip():
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session Supabase requise.")

    supabase_url = local_env_value("SUPABASE_URL") or local_env_value("VITE_SUPABASE_URL")
    publishable_key = local_env_value("SUPABASE_PUBLISHABLE_KEY") or local_env_value("VITE_SUPABASE_PUBLISHABLE_KEY")
    supabase_url = supabase_url.rstrip("/")
    if not supabase_url or not publishable_key:
        raise HTTPException(status_code=503, detail="Configuration Supabase du backend manquante.")

    try:
        response = httpx.get(
            f"{supabase_url}/auth/v1/user",
            headers={"apikey": publishable_key, "Authorization": f"Bearer {access_token.strip()}"},
            timeout=5,
        )
    except httpx.HTTPError as error:
        raise HTTPException(status_code=503, detail="Le service d’authentification est indisponible.") from error

    if response.status_code != 200:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session Supabase invalide ou expirée.")
    payload = response.json()
    user_id = payload.get("id") if isinstance(payload, dict) else None
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session Supabase invalide.")
    return AuthenticatedUser(user_id=str(user_id), access_token=access_token.strip())


def get_authenticated_user(authorization: str | None = Header(default=None)) -> AuthenticatedUser:
    return _verify_supabase_session(authorization)


def get_current_user_id(authorization: str | None = Header(default=None)) -> str:
    return _verify_supabase_session(authorization).user_id
