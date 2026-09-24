import os
from pathlib import Path

import httpx
from fastapi import Header, HTTPException, status


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


def get_current_user_id(authorization: str | None = Header(default=None)) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session Supabase requise.")

    supabase_url = local_env_value("SUPABASE_URL") or local_env_value("VITE_SUPABASE_URL")
    publishable_key = local_env_value("SUPABASE_PUBLISHABLE_KEY") or local_env_value("VITE_SUPABASE_PUBLISHABLE_KEY")
    supabase_url = supabase_url.rstrip("/")
    if not supabase_url or not publishable_key:
        raise HTTPException(status_code=503, detail="Configuration Supabase du backend manquante.")

    try:
        response = httpx.get(
            f"{supabase_url}/auth/v1/user",
            headers={"apikey": publishable_key, "Authorization": authorization},
            timeout=5,
        )
    except httpx.HTTPError as error:
        raise HTTPException(status_code=503, detail="Le service d’authentification est indisponible.") from error

    if response.status_code != 200:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session Supabase invalide ou expirée.")
    user_id = response.json().get("id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session Supabase invalide.")
    return str(user_id)
