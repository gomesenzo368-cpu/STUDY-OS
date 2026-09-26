from collections.abc import AsyncIterator
from datetime import date, datetime, timezone
import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from ..auth import AuthenticatedUser, get_authenticated_user, local_env_value
from .context import AIContext
from .core import AICore, AIResponse
from .tools.planning import (
    AuthenticatedPlanningReader,
    PlanningAccessDenied,
    PlanningDataSourceUnavailable,
    PlanningIntegrationNotConfigured,
    SupabasePlanningReader,
    create_planning_tool,
)

router = APIRouter(prefix="/api/ai", tags=["ai"])
logger = logging.getLogger(__name__)


class AIChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    message: str = Field(min_length=1, max_length=8000)


async def get_planning_reader(
    user: AuthenticatedUser = Depends(get_authenticated_user),
) -> AsyncIterator[AuthenticatedPlanningReader]:
    supabase_url = local_env_value("SUPABASE_URL") or local_env_value("VITE_SUPABASE_URL")
    publishable_key = local_env_value("SUPABASE_PUBLISHABLE_KEY") or local_env_value("VITE_SUPABASE_PUBLISHABLE_KEY")
    if not supabase_url or not publishable_key:
        raise HTTPException(status_code=503, detail="Configuration Supabase du backend manquante.")

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            yield SupabasePlanningReader(
                user_id=user.user_id,
                access_token=user.access_token,
                supabase_url=supabase_url,
                publishable_key=publishable_key,
                client=client,
            )
    except PlanningIntegrationNotConfigured as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.get("/planning", response_model=AIResponse)
async def read_authenticated_planning(
    requested_date: date = Query(alias="date"),
    user: AuthenticatedUser = Depends(get_authenticated_user),
    reader: AuthenticatedPlanningReader = Depends(get_planning_reader),
) -> AIResponse:
    if reader.authenticated_user_id != user.user_id:
        raise HTTPException(status_code=403, detail="Lecteur Planning non lié à l'utilisateur authentifié.")

    core = AICore(tools=[create_planning_tool(reader)])
    context = AIContext(user_id=user.user_id)
    try:
        response = await core.execute_tool(
            "get_schedule",
            {"date": requested_date.isoformat()},
            context,
        )
    except PlanningAccessDenied as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    except PlanningIntegrationNotConfigured as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except PlanningDataSourceUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return response


@router.post("/chat", response_model=AIResponse)
async def chat(
    payload: AIChatRequest,
    user: AuthenticatedUser = Depends(get_authenticated_user),
    reader: AuthenticatedPlanningReader = Depends(get_planning_reader),
) -> AIResponse | JSONResponse:
    logger.info("ai_chat event=request_received message_length=%d", len(payload.message))
    if reader.authenticated_user_id != user.user_id:
        logger.warning("ai_chat event=planning_reader_identity status=mismatch")
        raise HTTPException(status_code=403, detail="Lecteur Planning non lié à l'utilisateur authentifié.")

    try:
        logger.info("ai_chat event=core_call status=started")
        response = await AICore(tools=[create_planning_tool(reader)]).respond(
            payload.message,
            AIContext(
                user_id=user.user_id,
                temporary_context={
                    "current_date": datetime.now(timezone.utc).date().isoformat(),
                    "date_timezone": "UTC",
                },
            ),
        )
    except Exception as error:
        logger.error("ai_chat event=core_call status=failed error_type=%s", type(error).__name__)
        response = AIResponse(status="error", error_code="assistant_request_failed")

    provider = response.provider if response.provider in {"groq", "gemini", "openrouter"} else "none"
    logger.info(
        "ai_chat event=response_ready status=%s provider=%s message_length=%d tool_failures=%d",
        response.status,
        provider,
        len(response.message or ""),
        len(response.provider_failures),
    )

    if response.status == "completed":
        return response

    status_code = 503 if response.status == "unavailable" else 502
    return JSONResponse(status_code=status_code, content=jsonable_encoder(response))