import base64
import copy
import json
import re
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, get_authenticated_user
from app.revisions_api import get_revision_service, router
from app.revisions_service import (
    RevisionServiceError,
    SupabaseRevisionService,
    _is_server_key,
)


def service_role_key() -> str:
    payload = base64.urlsafe_b64encode(json.dumps({"role": "service_role"}).encode()).decode().rstrip("=")
    return f"header.{payload}.signature"


def contains_json_key(value: Any, key: str) -> bool:
    if isinstance(value, dict):
        return key in value or any(contains_json_key(child, key) for child in value.values())
    if isinstance(value, list):
        return any(contains_json_key(child, key) for child in value)
    return False


def normalize_short_answer(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip()).lower()


def revision_migration_sql() -> str:
    return (Path(__file__).resolve().parents[2] / "supabase/migrations/014_revision_session_snapshot.sql").read_text()


class FakeRevisionService:
    user_id = "verified-user"

    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
        self.question: dict[str, Any] | None = {
            "id": 11,
            "course_id": 7,
            "question_type": "multiple_choice",
            "question_text": "Question publique",
            "choices": [{"id": "a", "text": "Option A"}],
            "difficulty": "easy",
            "position": 0,
        }
        self.questions: list[dict[str, Any]] = [self.question]
        self.answer_keys: dict[int, Any] = {11: "a"}
        self.sessions: dict[int, dict[str, Any]] = {}
        self.session_keys: dict[int, dict[int, Any]] = {}
        self.session_answers: dict[int, list[dict[str, Any]]] = {}
        self.error: RevisionServiceError | None = None

    def _record(self, name: str, *args: Any, **kwargs: Any) -> None:
        self.calls.append((name, args, kwargs))
        if self.error is not None:
            raise self.error

    async def list_course_questions(self, course_id: int) -> list[dict[str, Any]]:
        self._record("list_course_questions", course_id)
        return [self.question] if self.question else []

    async def start_session(self, course_id: int) -> dict[str, Any]:
        self._record("start_session", course_id)
        session_id = 19
        questions = [
            {
                "question_id": question["id"],
                "question_type": question["question_type"],
                "question_text": question["question_text"],
                "choices": copy.deepcopy(question["choices"]),
                "position": question["position"],
            }
            for question in self.questions
            if question and question["course_id"] == course_id
        ]
        session = {
            "session_id": 19,
            "user_id": self.user_id,
            "course_id": course_id,
            "status": "in_progress",
            "total_questions": len(questions),
            "correct_answers": 0,
            "score": 0,
            "started_at": "2026-09-26T10:00:00Z",
            "questions": questions,
            "snapshot_complete": True,
        }
        self.sessions[session_id] = session
        self.session_keys[session_id] = {
            question_id: copy.deepcopy(self.answer_keys[question_id])
            for question_id in (question["question_id"] for question in questions)
        }
        self.session_answers[session_id] = []
        return copy.deepcopy(session)

    async def list_sessions(self, *, status: str | None, limit: int) -> list[dict[str, Any]]:
        self._record("list_sessions", status=status, limit=limit)
        return [{"id": 19, "user_id": self.user_id, "status": status or "in_progress"}]

    async def get_session(self, session_id: int) -> dict[str, Any] | None:
        self._record("get_session", session_id)
        session = self.sessions.get(session_id)
        if session is None or session.get("user_id") != self.user_id:
            return None
        return {
            **copy.deepcopy(session),
            "id": session_id,
            "user_id": self.user_id,
            "answers": copy.deepcopy(self.session_answers[session_id]),
        }

    async def list_review_answers(self, *, limit: int) -> list[dict[str, Any]]:
        self._record("list_review_answers", limit=limit)
        return [{"question_text_snapshot": "Question historique", "is_correct": False}]

    async def submit_answer(self, session_id: int, question_id: int, answer: Any) -> dict[str, Any]:
        self._record("submit_answer", session_id, question_id, answer)
        session = self.sessions.get(session_id)
        if session is None:
            raise RevisionServiceError(404, "P0002")
        if not session.get("snapshot_complete", False):
            raise RevisionServiceError(409, "revision_session_snapshot_incomplete")
        snapshot = next(
            (question for question in session["questions"] if question["question_id"] == question_id),
            None,
        )
        if snapshot is None:
            raise RevisionServiceError(404, "P0002")
        if any(row["snapshot_question_id"] == question_id for row in self.session_answers[session_id]):
            raise RevisionServiceError(409, "23505")
        is_correct = answer == self.session_keys[session_id][question_id]
        answered_at = "2026-09-26T10:01:00Z"
        self.session_answers[session_id].append({
            "session_id": session_id,
            "question_id": question_id if any(q and q["id"] == question_id for q in self.questions) else None,
            "snapshot_question_id": question_id,
            "question_text_snapshot": snapshot["question_text"],
            "question_type_snapshot": snapshot["question_type"],
            "choices_snapshot": copy.deepcopy(snapshot["choices"]),
            "answer": answer,
            "is_correct": is_correct,
            "answered_at": answered_at,
        })
        correct_count = sum(row["is_correct"] for row in self.session_answers[session_id])
        total_questions = session["total_questions"]
        score = round(correct_count * 100 / total_questions, 2)
        session.update(correct_answers=correct_count, score=score)
        return {
            "is_correct": is_correct,
            "answered_at": answered_at,
            "correct_answers": correct_count,
            "total_questions": total_questions,
            "score": score,
        }

    async def close_session(self, session_id: int, status: str) -> dict[str, Any]:
        self._record("close_session", session_id, status)
        return {"session_id": session_id, "status": status, "duration_seconds": 60}

    async def save_question(
        self,
        *,
        course_id: int,
        question_id: int | None,
        fields: dict[str, Any],
    ) -> dict[str, Any]:
        self._record("save_question", course_id=course_id, question_id=question_id, fields=fields)
        return {"id": question_id or 12, "course_id": course_id, "question_text": fields["question_text"]}

    async def get_question(self, question_id: int) -> dict[str, Any] | None:
        self._record("get_question", question_id)
        return self.question if self.question and self.question["id"] == question_id else None

    async def delete_question(self, question_id: int) -> None:
        self._record("delete_question", question_id)


class RevisionApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.app = FastAPI()
        self.app.include_router(router)
        self.service = FakeRevisionService()
        self.app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser(
            "verified-user",
            "verified-access-token",
        )
        self.app.dependency_overrides[get_revision_service] = lambda: self.service
        self.client = TestClient(self.app)

    def tearDown(self) -> None:
        self.client.close()
        self.app.dependency_overrides.clear()

    def test_questions_endpoint_requires_authentication(self) -> None:
        self.app.dependency_overrides.clear()
        response = self.client.get("/api/revisions/courses/7/questions")
        self.assertEqual(response.status_code, 401)

    def test_questions_endpoint_returns_public_fields_only(self) -> None:
        response = self.client.get("/api/revisions/courses/7/questions")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()[0]["id"], 11)
        self.assertFalse(contains_json_key(response.json(), "correct_answer"))
        self.assertNotIn("revision_question_keys", response.text)

    def test_questions_endpoint_passes_requested_course(self) -> None:
        self.client.get("/api/revisions/courses/23/questions")
        self.assertEqual(self.service.calls[-1][1], (23,))

    def test_start_session_uses_course_only(self) -> None:
        response = self.client.post("/api/revisions/sessions", json={"course_id": 7})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(self.service.calls[-1][1], (7,))

    def test_start_session_returns_exact_multiple_question_snapshot(self) -> None:
        second_question = {
            "id": 12,
            "course_id": 7,
            "question_type": "true_false",
            "question_text": "La Terre tourne autour du Soleil ?",
            "choices": None,
            "position": 1,
        }
        self.service.questions.append(second_question)
        self.service.answer_keys[12] = True

        response = self.client.post("/api/revisions/sessions", json={"course_id": 7})

        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertEqual(body["total_questions"], 2)
        self.assertEqual(
            body["questions"],
            [
                {
                    "question_id": 11,
                    "question_type": "multiple_choice",
                    "question_text": "Question publique",
                    "choices": [{"id": "a", "text": "Option A"}],
                    "position": 0,
                },
                {
                    "question_id": 12,
                    "question_type": "true_false",
                    "question_text": "La Terre tourne autour du Soleil ?",
                    "choices": None,
                    "position": 1,
                },
            ],
        )
        self.assertFalse(contains_json_key(response.json(), "correct_answer"))

    def test_client_cannot_choose_session_user(self) -> None:
        response = self.client.post(
            "/api/revisions/sessions",
            json={"course_id": 7, "user_id": "attacker"},
        )
        self.assertEqual(response.status_code, 422)

    def test_client_cannot_choose_session_counters_or_snapshot(self) -> None:
        response = self.client.post(
            "/api/revisions/sessions",
            json={
                "course_id": 7,
                "total_questions": 100,
                "correct_answers": 100,
                "score": 100,
                "question_ids_snapshot": [1],
            },
        )
        self.assertEqual(response.status_code, 422)

    def test_client_cannot_choose_session_status_or_timestamps(self) -> None:
        response = self.client.post(
            "/api/revisions/sessions",
            json={
                "course_id": 7,
                "status": "completed",
                "started_at": "2000-01-01T00:00:00Z",
                "completed_at": "2000-01-01T00:01:00Z",
                "duration_seconds": 60,
            },
        )
        self.assertEqual(response.status_code, 422)

    def test_session_creation_error_does_not_expose_store_details(self) -> None:
        self.service.error = RevisionServiceError(404, "P0002")
        response = self.client.post("/api/revisions/sessions", json={"course_id": 900})
        self.assertEqual(response.status_code, 404)
        self.assertNotIn("P0002", response.text)

    def test_session_list_is_scoped_and_filters_status(self) -> None:
        response = self.client.get("/api/revisions/sessions?status=in_progress&limit=5")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.service.calls[-1][0], "list_sessions")
        self.assertEqual(self.service.calls[-1][2], {"status": "in_progress", "limit": 5})

    def test_missing_revision_configuration_returns_actionable_detail(self) -> None:
        self.app.dependency_overrides.pop(get_revision_service)
        with patch("app.revisions_api._supabase_configuration", side_effect=RevisionServiceError(503, "revision_backend_not_configured")):
            response = self.client.get("/api/revisions/sessions")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"], "Configuration Supabase du backend incomplète pour les révisions.")

    def test_missing_service_role_key_returns_safe_actionable_detail(self) -> None:
        self.app.dependency_overrides.pop(get_revision_service)
        with patch("app.revisions_api._supabase_configuration", side_effect=RevisionServiceError(503, "revision_service_role_key_not_configured")):
            response = self.client.get("/api/revisions/sessions")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"], "Clé service-role Supabase manquante ou invalide côté backend.")

    def test_session_list_rejects_unknown_status(self) -> None:
        response = self.client.get("/api/revisions/sessions?status=forged")
        self.assertEqual(response.status_code, 422)

    def test_session_detail_returns_not_found_for_other_session(self) -> None:
        response = self.client.get("/api/revisions/sessions/99")
        self.assertEqual(response.status_code, 404)

    def test_session_detail_hides_session_owned_by_another_user(self) -> None:
        self.service.sessions[88] = {"session_id": 88, "user_id": "another-user", "questions": []}
        response = self.client.get("/api/revisions/sessions/88")
        self.assertEqual(response.status_code, 404)

    def test_session_detail_returns_own_answers(self) -> None:
        self.client.post("/api/revisions/sessions", json={"course_id": 7})
        response = self.client.get("/api/revisions/sessions/19")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["user_id"], "verified-user")

    def test_session_detail_returns_snapshot_without_correction_key(self) -> None:
        self.client.post("/api/revisions/sessions", json={"course_id": 7})
        self.service.question["question_text"] = "Texte modifié après démarrage"
        response = self.client.get("/api/revisions/sessions/19")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["questions"][0]["question_text"], "Question publique")
        self.assertFalse(contains_json_key(response.json(), "correct_answer"))

    def test_historical_incomplete_session_is_identified_for_display(self) -> None:
        self.client.post("/api/revisions/sessions", json={"course_id": 7})
        self.service.sessions[19]["snapshot_complete"] = False

        response = self.client.get("/api/revisions/sessions/19")

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["snapshot_complete"])

    def test_historical_incomplete_session_has_clear_submit_error(self) -> None:
        self.client.post("/api/revisions/sessions", json={"course_id": 7})
        self.service.sessions[19]["snapshot_complete"] = False

        response = self.client.post(
            "/api/revisions/sessions/19/answers",
            json={"question_id": 11, "answer": "a"},
        )

        self.assertEqual(response.status_code, 409)
        self.assertIn("snapshot complet", response.json()["detail"])

    def test_answer_correctness_uses_key_snapshot(self) -> None:
        self.client.post("/api/revisions/sessions", json={"course_id": 7})
        self.service.question["question_text"] = "Texte modifié après démarrage"
        self.service.question["choices"] = [{"id": "b", "text": "Nouvelle option"}]
        self.service.answer_keys[11] = "b"

        response = self.client.post(
            "/api/revisions/sessions/19/answers",
            json={"question_id": 11, "answer": "a"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["is_correct"])
        self.assertEqual(response.json()["score"], 100)

    def test_incorrect_answer_updates_score_using_snapshot(self) -> None:
        self.client.post("/api/revisions/sessions", json={"course_id": 7})

        response = self.client.post(
            "/api/revisions/sessions/19/answers",
            json={"question_id": 11, "answer": "b"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["is_correct"])
        self.assertEqual(response.json()["correct_answers"], 0)
        self.assertEqual(response.json()["score"], 0)

    def test_deleted_source_question_remains_answerable_from_snapshot(self) -> None:
        self.client.post("/api/revisions/sessions", json={"course_id": 7})
        self.service.questions.clear()
        self.service.question = None

        response = self.client.post(
            "/api/revisions/sessions/19/answers",
            json={"question_id": 11, "answer": "a"},
        )
        session_response = self.client.get("/api/revisions/sessions/19")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["is_correct"])
        self.assertEqual(session_response.status_code, 200)
        self.assertEqual(session_response.json()["questions"][0]["question_text"], "Question publique")
        self.assertIsNone(session_response.json()["answers"][0]["question_id"])
        self.assertEqual(session_response.json()["answers"][0]["snapshot_question_id"], 11)
        self.assertFalse(contains_json_key(session_response.json(), "correct_answer"))

    def test_answer_body_requires_question_and_answer(self) -> None:
        response = self.client.post("/api/revisions/sessions/19/answers", json={"question_id": 11})
        self.assertEqual(response.status_code, 422)

    def test_client_cannot_supply_is_correct_or_score(self) -> None:
        response = self.client.post(
            "/api/revisions/sessions/19/answers",
            json={
                "question_id": 11,
                "answer": "a",
                "is_correct": True,
                "correct_answers": 1,
                "score": 100,
            },
        )
        self.assertEqual(response.status_code, 422)

    def test_answer_passes_only_session_question_and_answer(self) -> None:
        self.client.post("/api/revisions/sessions", json={"course_id": 7})
        response = self.client.post(
            "/api/revisions/sessions/19/answers",
            json={"question_id": 11, "answer": "a"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.service.calls[-1][1], (19, 11, "a"))

    def test_answer_result_contains_only_validation_result(self) -> None:
        self.client.post("/api/revisions/sessions", json={"course_id": 7})
        response = self.client.post(
            "/api/revisions/sessions/19/answers",
            json={"question_id": 11, "answer": "a"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("is_correct", response.json())
        self.assertFalse(contains_json_key(response.json(), "correct_answer"))

    def test_answer_maps_duplicate_to_conflict(self) -> None:
        self.service.error = RevisionServiceError(409, "23505")
        response = self.client.post(
            "/api/revisions/sessions/19/answers",
            json={"question_id": 11, "answer": "a"},
        )
        self.assertEqual(response.status_code, 409)

    def test_answer_maps_closed_session_to_conflict(self) -> None:
        self.service.error = RevisionServiceError(409, "55000")
        response = self.client.post(
            "/api/revisions/sessions/19/answers",
            json={"question_id": 11, "answer": "a"},
        )
        self.assertEqual(response.status_code, 409)

    def test_answer_maps_wrong_course_or_owner_to_not_found(self) -> None:
        self.service.error = RevisionServiceError(404, "P0002")
        response = self.client.post(
            "/api/revisions/sessions/19/answers",
            json={"question_id": 900, "answer": "a"},
        )
        self.assertEqual(response.status_code, 404)

    def test_complete_uses_server_selected_status(self) -> None:
        response = self.client.post("/api/revisions/sessions/19/complete")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.service.calls[-1][1], (19, "completed"))

    def test_abandon_uses_server_selected_status(self) -> None:
        response = self.client.post("/api/revisions/sessions/19/abandon")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.service.calls[-1][1], (19, "abandoned"))

    def test_review_uses_persisted_failed_answers(self) -> None:
        response = self.client.get("/api/revisions/review")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()[0]["question_text_snapshot"], "Question historique")

    def test_create_question_saves_key_without_returning_it(self) -> None:
        response = self.client.post(
            "/api/revisions/courses/7/questions",
            json={
                "question_type": "multiple_choice",
                "question_text": "Question ?",
                "choices": [{"id": "a", "text": "Option A"}, {"id": "b", "text": "Option B"}],
                "correct_answer": "a",
            },
        )
        self.assertEqual(response.status_code, 201)
        self.assertNotIn("correct_answer", response.text)
        self.assertEqual(self.service.calls[-1][2]["fields"]["correct_answer"], "a")

    def test_question_authoring_rejects_extra_user_id(self) -> None:
        response = self.client.post(
            "/api/revisions/courses/7/questions",
            json={
                "user_id": "attacker",
                "question_type": "true_false",
                "question_text": "Vrai ?",
                "correct_answer": True,
            },
        )
        self.assertEqual(response.status_code, 422)

    def test_question_update_does_not_move_question_between_courses(self) -> None:
        response = self.client.put(
            "/api/revisions/questions/11",
            json={
                "question_type": "short_answer",
                "question_text": "Question ?",
                "correct_answer": "réponse",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.service.calls[-1][2]["course_id"], 7)

    def test_question_update_requires_owned_question(self) -> None:
        self.service.question = None
        response = self.client.put(
            "/api/revisions/questions/99",
            json={
                "question_type": "short_answer",
                "question_text": "Question ?",
                "correct_answer": "réponse",
            },
        )
        self.assertEqual(response.status_code, 404)

    def test_question_delete_uses_privileged_service_operation(self) -> None:
        response = self.client.delete("/api/revisions/questions/11")
        self.assertEqual(response.status_code, 204)
        self.assertEqual(self.service.calls[-1][1], (11,))


class RevisionServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_short_answer_normalization_cases_match_v1_rule(self) -> None:
        cases = (
            ("réponse exacte", "réponse exacte"),
            ("RÉPONSE EXACTE", "réponse exacte"),
            ("plusieurs   espaces internes", "plusieurs espaces internes"),
            ("  espaces autour  ", "espaces autour"),
            ("\ttabulations autour\t", "tabulations autour"),
            (" \t espaces \t et \t tabulations \t ", "espaces et tabulations"),
        )
        for candidate, expected in cases:
            with self.subTest(candidate=repr(candidate)):
                self.assertEqual(normalize_short_answer(candidate), normalize_short_answer(expected))

    async def test_short_answer_sql_uses_explicit_whitespace_trim_and_collapse(self) -> None:
        sql = revision_migration_sql()
        self.assertIn("'^[[:space:]]+|[[:space:]]+$'", sql)
        self.assertIn("'[[:space:]]+'", sql)
        self.assertNotIn("pg_catalog.btrim(p_answer", sql)

    async def test_historical_backfill_does_not_reconstruct_live_questions_or_keys(self) -> None:
        sql = revision_migration_sql()
        backfill = sql.split("alter table public.revision_session_questions enable row level security", 1)[0]
        self.assertIn("from public.revision_answers as answer", backfill)
        self.assertNotIn("cross join lateral unnest", backfill)
        self.assertNotIn("from public.revision_question_keys as question_key", backfill)
        self.assertIn("snapshot_version smallint not null default 0", sql)
        self.assertIn("v_key_count <> v_snapshot_count", sql)

    async def test_old_start_rpc_is_revoked_and_backend_uses_snapshot_rpc(self) -> None:
        sql = " ".join(revision_migration_sql().split())
        self.assertIn(
            "revoke all on function public.start_revision_session(uuid, bigint) from public, anon, authenticated, service_role",
            sql,
        )
        service_source = (Path(__file__).resolve().parents[1] / "app/revisions_service.py").read_text()
        self.assertIn('"start_revision_session_snapshot"', service_source)
        self.assertNotIn('"start_revision_session",', service_source)

    async def test_user_reads_forward_verified_bearer_and_public_key(self) -> None:
        seen: list[httpx.Request] = []

        def respond(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=[{
                "id": 4,
                "course_id": 7,
                "question_type": "short_answer",
                "question_text": "Question",
                "correct_answer": "must-not-escape",
            }])

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            service = SupabaseRevisionService(
                user=AuthenticatedUser("verified-user", "user-jwt"),
                supabase_url="https://project.supabase.co",
                publishable_key="public-key",
                service_role_key=service_role_key(),
                client=client,
            )
            questions = await service.list_course_questions(7)

        self.assertEqual(seen[0].headers["authorization"], "Bearer user-jwt")
        self.assertEqual(seen[0].headers["apikey"], "public-key")
        self.assertNotIn("correct_answer", questions[0])

    async def test_rpc_uses_backend_service_role_only(self) -> None:
        seen: list[httpx.Request] = []

        def respond(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=[{
                "session_id": 5,
                "question_ids_snapshot": [1],
                "questions": [{
                    "question_id": 1,
                    "question_type": "short_answer",
                    "question_text": "Snapshot",
                    "choices": None,
                    "position": 0,
                }],
            }])

        key = service_role_key()
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            service = SupabaseRevisionService(
                user=AuthenticatedUser("verified-user", "user-jwt"),
                supabase_url="https://project.supabase.co",
                publishable_key="public-key",
                service_role_key=key,
                client=client,
            )
            session = await service.start_session(7)

        self.assertEqual(seen[0].headers["authorization"], f"Bearer {key}")
        self.assertEqual(seen[0].headers["apikey"], key)
        self.assertTrue(seen[0].url.path.endswith("/rpc/start_revision_session_snapshot"))
        self.assertEqual(seen[0].read(), b'{"p_user_id":"verified-user","p_course_id":7}')
        self.assertNotIn("question_ids_snapshot", session)
        self.assertEqual(session["questions"][0]["question_text"], "Snapshot")
        self.assertFalse(contains_json_key(session, "correct_answer"))

    async def test_get_session_reads_snapshot_and_answers_with_user_bearer(self) -> None:
        seen: list[httpx.Request] = []

        def respond(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            if request.url.path.endswith("/revision_sessions"):
                return httpx.Response(200, json=[{
                    "id": 5,
                    "user_id": "verified-user",
                    "course_id": 7,
                    "question_ids_snapshot": [1],
                    "status": "in_progress",
                }])
            if request.url.path.endswith("/revision_session_questions"):
                return httpx.Response(200, json=[{
                    "question_id": 1,
                    "question_type": "short_answer",
                    "question_text": "Snapshot exact",
                    "choices": None,
                    "position": 0,
                }])
            if request.url.path.endswith("/rpc/revision_session_snapshot_status"):
                return httpx.Response(200, json=[{"snapshot_complete": True}])
            return httpx.Response(200, json=[])

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            service = SupabaseRevisionService(
                user=AuthenticatedUser("verified-user", "user-jwt"),
                supabase_url="https://project.supabase.co",
                publishable_key="public-key",
                service_role_key=service_role_key(),
                client=client,
            )
            session = await service.get_session(5)

        self.assertIsNotNone(session)
        self.assertEqual(session["questions"][0]["question_text"], "Snapshot exact")
        self.assertEqual(len(seen), 4)
        self.assertTrue(all(request.headers["authorization"] == "Bearer user-jwt" for request in seen[:3]))
        self.assertEqual(seen[3].headers["authorization"], f"Bearer {service_role_key()}")
        self.assertEqual(seen[1].url.params["session_id"], "eq.5")
        self.assertFalse(contains_json_key(session, "correct_answer"))
        self.assertTrue(session["snapshot_complete"])

    async def test_incomplete_session_status_returns_conflict_before_submit_rpc(self) -> None:
        seen: list[httpx.Request] = []

        def respond(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=[{"snapshot_complete": False}])

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            service = SupabaseRevisionService(
                user=AuthenticatedUser("verified-user", "user-jwt"),
                supabase_url="https://project.supabase.co",
                publishable_key="public-key",
                service_role_key=service_role_key(),
                client=client,
            )
            with self.assertRaises(RevisionServiceError) as caught:
                await service.submit_answer(5, 11, "a")

        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(caught.exception.code, "revision_session_snapshot_incomplete")
        self.assertTrue(seen[0].url.path.endswith("/rpc/revision_session_snapshot_status"))
        self.assertEqual(len(seen), 1)

    async def test_server_key_must_be_service_role_jwt(self) -> None:
        self.assertTrue(_is_server_key(service_role_key()))
        self.assertFalse(_is_server_key("public-key"))
        self.assertTrue(_is_server_key("sb_secret_backend-only-key"))

    async def test_remote_database_details_are_not_exposed_or_logged(self) -> None:
        secret = "correct-answer-sentinel"

        def respond(_: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"code": "XX000", "message": secret})

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            service = SupabaseRevisionService(
                user=AuthenticatedUser("verified-user", "jwt-sentinel"),
                supabase_url="https://project.supabase.co",
                publishable_key="public-key",
                service_role_key=service_role_key(),
                client=client,
            )
            with self.assertNoLogs("app.revisions_service", level="INFO"):
                with self.assertRaises(RevisionServiceError) as caught:
                    await service.submit_answer(1, 2, "guess")

        self.assertNotIn(secret, str(caught.exception))
        self.assertNotIn("jwt-sentinel", str(caught.exception))


if __name__ == "__main__":
    unittest.main()