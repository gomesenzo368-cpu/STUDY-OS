import base64
import binascii
import json
import os
from collections.abc import Mapping
from typing import Any

import httpx

from .auth import AuthenticatedUser, local_env_value


class RevisionServiceError(Exception):
    def __init__(self, status_code: int, code: str = "revision_service_error") -> None:
        super().__init__(code)
        self.status_code = status_code
        self.code = code


def _is_server_key(value: str) -> bool:
    if value.startswith("sb_secret_"):
        return True
    parts = value.split(".")
    if len(parts) != 3:
        return False
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload))
    except (ValueError, binascii.Error):
        return False
    return isinstance(claims, dict) and claims.get("role") == "service_role"


def _supabase_configuration() -> tuple[str, str, str]:
    supabase_url = (
        local_env_value("SUPABASE_URL") or local_env_value("VITE_SUPABASE_URL")
    ).rstrip("/")
    publishable_key = local_env_value("SUPABASE_PUBLISHABLE_KEY") or local_env_value(
        "VITE_SUPABASE_PUBLISHABLE_KEY"
    )
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not supabase_url or not publishable_key:
        raise RevisionServiceError(503, "revision_backend_not_configured")
    if not _is_server_key(service_role_key):
        raise RevisionServiceError(503, "revision_service_role_key_not_configured")
    return supabase_url, publishable_key, service_role_key


class SupabaseRevisionService:
    def __init__(
        self,
        *,
        user: AuthenticatedUser,
        supabase_url: str,
        publishable_key: str,
        service_role_key: str,
        client: httpx.AsyncClient,
    ) -> None:
        if not user.user_id or not user.access_token or not supabase_url or not publishable_key:
            raise RevisionServiceError(503, "revision_backend_not_configured")
        if not _is_server_key(service_role_key):
            raise RevisionServiceError(503, "revision_backend_not_configured")
        self.user_id = user.user_id
        self._access_token = user.access_token
        self._supabase_url = supabase_url.rstrip("/")
        self._publishable_key = publishable_key
        self._service_role_key = service_role_key
        self._client = client

    @property
    def _user_headers(self) -> dict[str, str]:
        return {
            "apikey": self._publishable_key,
            "Authorization": f"Bearer {self._access_token}",
        }

    @property
    def _service_headers(self) -> dict[str, str]:
        return {
            "apikey": self._service_role_key,
            "Authorization": f"Bearer {self._service_role_key}",
            "Content-Type": "application/json",
        }

    async def _request(
        self,
        method: str,
        path: str,
        *,
        privileged: bool = False,
        params: Mapping[str, str] | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> Any:
        try:
            response = await self._client.request(
                method,
                f"{self._supabase_url}/rest/v1/{path}",
                params=params,
                json=payload,
                headers=self._service_headers if privileged else self._user_headers,
            )
        except httpx.HTTPError as error:
            raise RevisionServiceError(503, "revision_data_source_unavailable") from None

        if not response.is_success:
            try:
                error_payload = response.json()
            except ValueError:
                error_payload = {}
            error_code = error_payload.get("code") if isinstance(error_payload, dict) else None
            code = error_code if isinstance(error_code, str) else "revision_data_source_error"
            status_code = {
                "P0002": 404,
                "P0003": 409,
                "23503": 404,
                "23505": 409,
                "55000": 409,
                "P0001": 409,
                "22023": 422,
                "42501": 404,
            }.get(code, 503)
            raise RevisionServiceError(status_code, code)

        if response.status_code == 204 or not response.content:
            return None
        try:
            return response.json()
        except ValueError as error:
            raise RevisionServiceError(503, "revision_data_source_invalid_response") from None

    async def _user_select(
        self,
        table: str,
        columns: str,
        params: Mapping[str, str],
    ) -> list[dict[str, Any]]:
        rows = await self._request(
            "GET",
            table,
            params={"select": columns, **params},
        )
        if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
            raise RevisionServiceError(503, "revision_data_source_invalid_response")
        return rows

    async def _rpc(self, name: str, payload: Mapping[str, Any]) -> Any:
        return await self._request("POST", f"rpc/{name}", privileged=True, payload=payload)

    @staticmethod
    def _one_row(response: Any) -> dict[str, Any]:
        if isinstance(response, list) and len(response) == 1 and isinstance(response[0], dict):
            return response[0]
        if isinstance(response, dict):
            return response
        raise RevisionServiceError(503, "revision_data_source_invalid_response")

    async def list_course_questions(self, course_id: int) -> list[dict[str, Any]]:
        rows = await self._user_select(
            "revision_questions",
            "id,course_id,question_type,question_text,choices,explanation,difficulty,position,created_at,updated_at",
            {"course_id": f"eq.{course_id}", "order": "position.asc,id.asc"},
        )
        return [self._public_question(row) for row in rows]

    async def start_session(self, course_id: int) -> dict[str, Any]:
        result = await self._rpc(
            "start_revision_session_snapshot",
            {"p_user_id": self.user_id, "p_course_id": course_id},
        )
        row = self._one_row(result)
        return {
            field: row[field]
            for field in (
                "session_id", "course_id", "status", "total_questions",
                "correct_answers", "score", "started_at", "created_at", "questions",
            )
            if field in row
        }

    async def list_sessions(self, *, status: str | None, limit: int) -> list[dict[str, Any]]:
        params = {
            "user_id": f"eq.{self.user_id}",
            "order": "started_at.desc,id.desc",
            "limit": str(limit),
        }
        if status is not None:
            params["status"] = f"eq.{status}"
        return await self._user_select(
            "revision_sessions",
            "id,user_id,course_id,status,total_questions,correct_answers,score,started_at,completed_at,duration_seconds,created_at",
            params,
        )

    async def get_session(self, session_id: int) -> dict[str, Any] | None:
        rows = await self._user_select(
            "revision_sessions",
            "id,user_id,course_id,status,total_questions,correct_answers,score,started_at,completed_at,duration_seconds,created_at",
            {"id": f"eq.{session_id}", "user_id": f"eq.{self.user_id}", "limit": "1"},
        )
        if not rows:
            return None
        session = rows[0]
        session["questions"] = await self._user_select(
            "revision_session_questions",
            "question_id,question_type,question_text,choices,position",
            {"session_id": f"eq.{session_id}", "order": "position.asc,question_id.asc"},
        )
        session["answers"] = await self._user_select(
            "revision_answers",
            "id,session_id,question_id,snapshot_question_id,question_text_snapshot,question_type_snapshot,choices_snapshot,answer,is_correct,answered_at",
            {"session_id": f"eq.{session_id}", "order": "answered_at.asc,id.asc"},
        )
        session["snapshot_complete"] = await self._session_snapshot_complete(session_id)
        return session

    async def _session_snapshot_complete(self, session_id: int) -> bool:
        result = await self._rpc(
            "revision_session_snapshot_status",
            {"p_user_id": self.user_id, "p_session_id": session_id},
        )
        row = self._one_row(result)
        snapshot_complete = row.get("snapshot_complete")
        if not isinstance(snapshot_complete, bool):
            raise RevisionServiceError(503, "revision_data_source_invalid_response")
        return snapshot_complete

    async def list_review_answers(self, *, limit: int) -> list[dict[str, Any]]:
        rows = await self._user_select(
            "revision_answers",
            "id,session_id,question_id,question_text_snapshot,question_type_snapshot,choices_snapshot,answer,is_correct,answered_at,revision_sessions!inner(user_id)",
            {
                "revision_sessions.user_id": f"eq.{self.user_id}",
                "is_correct": "eq.false",
                "order": "answered_at.desc,id.desc",
                "limit": str(limit),
            },
        )
        public_fields = {
            "id", "session_id", "question_id", "question_text_snapshot",
            "question_type_snapshot", "choices_snapshot", "answer", "is_correct", "answered_at",
        }
        return [{key: value for key, value in row.items() if key in public_fields} for row in rows]

    async def submit_answer(
        self,
        session_id: int,
        question_id: int,
        answer: Any,
    ) -> dict[str, Any]:
        if not await self._session_snapshot_complete(session_id):
            raise RevisionServiceError(409, "revision_session_snapshot_incomplete")
        result = await self._rpc(
            "submit_revision_answer",
            {
                "p_user_id": self.user_id,
                "p_session_id": session_id,
                "p_question_id": question_id,
                "p_answer": answer,
            },
        )
        return self._one_row(result)

    async def close_session(self, session_id: int, status: str) -> dict[str, Any]:
        result = await self._rpc(
            "close_revision_session",
            {"p_user_id": self.user_id, "p_session_id": session_id, "p_status": status},
        )
        return self._one_row(result)

    async def save_question(
        self,
        *,
        course_id: int,
        question_id: int | None,
        fields: Mapping[str, Any],
    ) -> dict[str, Any]:
        result = await self._rpc(
            "save_revision_question",
            {
                "p_user_id": self.user_id,
                "p_course_id": course_id,
                "p_question_id": question_id,
                "p_question_type": fields["question_type"],
                "p_question_text": fields["question_text"],
                "p_choices": fields.get("choices"),
                "p_explanation": fields.get("explanation"),
                "p_difficulty": fields["difficulty"],
                "p_position": fields["position"],
                "p_correct_answer": fields["correct_answer"],
            },
        )
        return self._public_question(self._one_row(result))

    async def get_question(self, question_id: int) -> dict[str, Any] | None:
        rows = await self._user_select(
            "revision_questions",
            "id,course_id,question_type,question_text,choices,explanation,difficulty,position,created_at,updated_at",
            {"id": f"eq.{question_id}", "limit": "1"},
        )
        return self._public_question(rows[0]) if rows else None

    async def delete_question(self, question_id: int) -> None:
        await self._rpc(
            "delete_revision_question",
            {"p_user_id": self.user_id, "p_question_id": question_id},
        )

    @staticmethod
    def _public_question(row: Mapping[str, Any]) -> dict[str, Any]:
        fields = (
            "id", "course_id", "question_type", "question_text", "choices",
            "explanation", "difficulty", "position", "created_at", "updated_at",
        )
        return {field: row[field] for field in fields if field in row}