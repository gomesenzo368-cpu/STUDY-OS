from collections.abc import AsyncIterator
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field

from .auth import AuthenticatedUser, get_authenticated_user
from .revisions_service import (
    RevisionServiceError,
    SupabaseRevisionService,
    _supabase_configuration,
)

router = APIRouter(prefix="/api/revisions", tags=["revisions"])

QuestionType = Literal["multiple_choice", "true_false", "short_answer"]
Difficulty = Literal["easy", "medium", "hard"]
SessionStatus = Literal["in_progress", "completed", "abandoned"]
JsonValue = Any


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StartSessionRequest(StrictModel):
    course_id: int = Field(gt=0)


class SubmitAnswerRequest(StrictModel):
    question_id: int = Field(gt=0)
    answer: JsonValue


class ChoiceOption(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    text: str = Field(min_length=1, max_length=4000)


class SaveQuestionRequest(StrictModel):
    question_type: QuestionType
    question_text: str = Field(min_length=1, max_length=12000)
    choices: list[ChoiceOption] | None = None
    explanation: str | None = Field(default=None, max_length=12000)
    difficulty: Difficulty = "medium"
    position: int = Field(default=0, ge=0)
    correct_answer: JsonValue


async def get_revision_service(
    user: AuthenticatedUser = Depends(get_authenticated_user),
) -> AsyncIterator[SupabaseRevisionService]:
    try:
        supabase_url, publishable_key, service_role_key = _supabase_configuration()
    except RevisionServiceError as error:
        detail = {
            "revision_backend_not_configured": "Configuration Supabase du backend incomplète pour les révisions.",
            "revision_service_role_key_not_configured": "Clé service-role Supabase manquante ou invalide côté backend.",
        }.get(error.code, "Révisions indisponibles.")
        raise HTTPException(status_code=error.status_code, detail=detail) from None

    async with httpx.AsyncClient(timeout=8) as client:
        yield SupabaseRevisionService(
            user=user,
            supabase_url=supabase_url,
            publishable_key=publishable_key,
            service_role_key=service_role_key,
            client=client,
        )


def _raise_http_error(error: RevisionServiceError) -> None:
    if error.code == "revision_session_snapshot_incomplete":
        raise HTTPException(
            status_code=409,
            detail="Cette ancienne session ne possède pas un snapshot complet et ne peut pas être poursuivie.",
        ) from None
    detail = {
        404: "Ressource de révision introuvable.",
        409: "Cette opération ne peut pas être effectuée dans l’état actuel.",
        422: "Les données de révision sont invalides.",
        503: "Le service de révision est temporairement indisponible.",
    }.get(error.status_code, "Erreur du service de révision.")
    raise HTTPException(status_code=error.status_code, detail=detail) from None


@router.get("/courses/{course_id}/questions")
async def list_course_questions(
    course_id: int,
    service: SupabaseRevisionService = Depends(get_revision_service),
) -> list[dict[str, Any]]:
    try:
        return await service.list_course_questions(course_id)
    except RevisionServiceError as error:
        _raise_http_error(error)


@router.post("/sessions", status_code=status.HTTP_201_CREATED)
async def start_revision_session(
    payload: StartSessionRequest,
    service: SupabaseRevisionService = Depends(get_revision_service),
) -> dict[str, Any]:
    try:
        return await service.start_session(payload.course_id)
    except RevisionServiceError as error:
        _raise_http_error(error)


@router.get("/sessions")
async def list_revision_sessions(
    session_status: SessionStatus | None = Query(default=None, alias="status"),
    limit: int = Query(default=50, ge=1, le=100),
    service: SupabaseRevisionService = Depends(get_revision_service),
) -> list[dict[str, Any]]:
    try:
        return await service.list_sessions(status=session_status, limit=limit)
    except RevisionServiceError as error:
        _raise_http_error(error)


@router.get("/sessions/{session_id}")
async def get_revision_session(
    session_id: int,
    service: SupabaseRevisionService = Depends(get_revision_service),
) -> dict[str, Any]:
    try:
        session = await service.get_session(session_id)
    except RevisionServiceError as error:
        _raise_http_error(error)
    if session is None:
        raise HTTPException(status_code=404, detail="Session de révision introuvable.")
    return session


@router.post("/sessions/{session_id}/answers")
async def submit_revision_answer(
    session_id: int,
    payload: SubmitAnswerRequest,
    service: SupabaseRevisionService = Depends(get_revision_service),
) -> dict[str, Any]:
    try:
        return await service.submit_answer(session_id, payload.question_id, payload.answer)
    except RevisionServiceError as error:
        _raise_http_error(error)


@router.post("/sessions/{session_id}/complete")
async def complete_revision_session(
    session_id: int,
    service: SupabaseRevisionService = Depends(get_revision_service),
) -> dict[str, Any]:
    try:
        return await service.close_session(session_id, "completed")
    except RevisionServiceError as error:
        _raise_http_error(error)


@router.post("/sessions/{session_id}/abandon")
async def abandon_revision_session(
    session_id: int,
    service: SupabaseRevisionService = Depends(get_revision_service),
) -> dict[str, Any]:
    try:
        return await service.close_session(session_id, "abandoned")
    except RevisionServiceError as error:
        _raise_http_error(error)


@router.get("/review")
async def list_review_questions(
    limit: int = Query(default=100, ge=1, le=200),
    service: SupabaseRevisionService = Depends(get_revision_service),
) -> list[dict[str, Any]]:
    try:
        return await service.list_review_answers(limit=limit)
    except RevisionServiceError as error:
        _raise_http_error(error)


@router.post("/courses/{course_id}/questions", status_code=status.HTTP_201_CREATED)
async def create_revision_question(
    course_id: int,
    payload: SaveQuestionRequest,
    service: SupabaseRevisionService = Depends(get_revision_service),
) -> dict[str, Any]:
    try:
        return await service.save_question(
            course_id=course_id,
            question_id=None,
            fields=payload.model_dump(mode="json"),
        )
    except RevisionServiceError as error:
        _raise_http_error(error)


@router.put("/questions/{question_id}")
async def update_revision_question(
    question_id: int,
    payload: SaveQuestionRequest,
    service: SupabaseRevisionService = Depends(get_revision_service),
) -> dict[str, Any]:
    try:
        question = await service.get_question(question_id)
        if question is None:
            raise HTTPException(status_code=404, detail="Question introuvable.")
        return await service.save_question(
            course_id=int(question["course_id"]),
            question_id=question_id,
            fields=payload.model_dump(mode="json"),
        )
    except RevisionServiceError as error:
        _raise_http_error(error)


@router.delete("/questions/{question_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_revision_question(
    question_id: int,
    service: SupabaseRevisionService = Depends(get_revision_service),
) -> Response:
    try:
        await service.delete_question(question_id)
    except RevisionServiceError as error:
        _raise_http_error(error)
    return Response(status_code=status.HTTP_204_NO_CONTENT)