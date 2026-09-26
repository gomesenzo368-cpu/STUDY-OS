import base64
import json
import unittest
from datetime import date
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.ai.api import get_planning_reader, router
from app.ai.context import AIContext
from app.ai.tools.planning import (
    PlanningAccessDenied,
    PlanningIntegrationNotConfigured,
    SupabasePlanningReader,
    _schedule_for_date,
    create_planning_tool,
    get_schedule,
)
from app.auth import AuthenticatedUser, get_authenticated_user


def make_series(
    identifier: int,
    title: str,
    weekday: int,
    *,
    recurrence: str = "weekly",
    week_pattern: str = "all",
    starts_on: str = "2026-08-31",
    status: str = "active",
    subject_id: int | None = None,
) -> dict[str, object]:
    return {
        "id": identifier,
        "year_id": 4,
        "entry_type": "class",
        "title": title,
        "subject_id": subject_id,
        "teacher": "Prof",
        "room": "A1",
        "day_of_week": weekday,
        "recurrence": recurrence,
        "week_pattern": week_pattern,
        "starts_on": starts_on,
        "ends_on": None if recurrence == "once" else "2027-06-30",
        "start_time": "09:00:00",
        "end_time": "10:00:00",
        "color_key": None,
        "icon_key": None,
        "status": status,
    }


class PlanningReaderTests(unittest.IsolatedAsyncioTestCase):
    async def test_reader_forwards_user_bearer_and_projects_date(self) -> None:
        date_key = "2026-09-28"
        tables = {
            "planning_years": [{
                "id": 4,
                "name": "Année scolaire",
                "starts_on": "2026-08-31",
                "ends_on": "2027-06-30",
                "time_zone": "UTC",
            }],
            "planning_calendar_blocks": [],
            "planning_series": [
                make_series(1, "Paire non affichée", 1, week_pattern="even"),
                make_series(2, "Cours annulé", 1, week_pattern="odd", subject_id=42),
                make_series(3, "Cours déplacé", 2, week_pattern="even"),
                make_series(4, "Séance ponctuelle", 1, recurrence="once", starts_on=date_key),
            ],
            "planning_exceptions": [
                {
                    "id": 10,
                    "series_id": 2,
                    "occurrence_date": date_key,
                    "status": "cancelled",
                    "override_date": None,
                    "overrides": {"title": "Cours annulé modifié", "teacher": None, "subject_id": None},
                },
                {
                    "id": 11,
                    "series_id": 3,
                    "occurrence_date": "2026-09-22",
                    "status": "modified",
                    "override_date": date_key,
                    "overrides": {"start_time": "10:30:00"},
                },
            ],
        }
        seen_requests: list[httpx.Request] = []

        def respond(request: httpx.Request) -> httpx.Response:
            seen_requests.append(request)
            self.assertEqual(request.headers["authorization"], "Bearer verified-access-token")
            self.assertEqual(request.headers["apikey"], "public-key")
            self.assertEqual(request.url.params["user_id"], "eq.authenticated-user")
            table = request.url.path.rsplit("/", 1)[-1]
            return httpx.Response(200, json=tables[table])

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            reader = SupabasePlanningReader(
                user_id="authenticated-user",
                access_token="verified-access-token",
                supabase_url="https://project.supabase.co",
                publishable_key="public-key",
                client=client,
            )
            result = await reader.read_schedule(date.fromisoformat(date_key))

        events = result["events"]
        self.assertEqual(
            [event["title"] for event in events],
            ["Cours annulé modifié", "Séance ponctuelle", "Cours déplacé"],
        )
        self.assertTrue(events[0]["cancelled"])
        self.assertEqual(events[0]["teacher"], "")
        self.assertIsNone(events[0]["subject_id"])
        self.assertEqual(events[2]["occurrence_date"], "2026-09-22")
        self.assertEqual(events[2]["start_time"], "10:30")
        self.assertEqual(len(seen_requests), 4)

    async def test_authenticated_identity_is_required_and_tool_rejects_user_id_argument(self) -> None:
        class Reader:
            authenticated_user_id = "authenticated-user"

            async def read_schedule(self, requested_date: date) -> dict[str, object]:
                return {"date": requested_date.isoformat(), "events": []}

        reader = Reader()
        tool = create_planning_tool(reader)
        context = AIContext(user_id="authenticated-user")

        with self.assertRaises(ValueError):
            await tool.handler(context, {"date": "2026-09-28", "user_id": "other-user"})
        with self.assertRaises(PlanningAccessDenied):
            await get_schedule("other-user", date(2026, 9, 28), reader=reader)

    async def test_calendar_block_suppresses_occurrences(self) -> None:
        result = _schedule_for_date(
            date(2026, 9, 28),
            {
                "id": 4,
                "name": "Année scolaire",
                "starts_on": "2026-08-31",
                "ends_on": "2027-06-30",
                "time_zone": "UTC",
            },
            [{"id": 8, "kind": "break", "name": "Pause", "starts_on": "2026-09-28", "ends_on": "2026-10-02"}],
            [make_series(1, "Cours", 1)],
            [],
        )
        self.assertEqual(result["events"], [])
        self.assertEqual(result["calendar_blocks"][0]["name"], "Pause")

    async def test_service_role_key_is_refused(self) -> None:
        payload = base64.urlsafe_b64encode(json.dumps({"role": "service_role"}).encode()).decode().rstrip("=")
        async with httpx.AsyncClient() as client:
            with self.assertRaises(PlanningIntegrationNotConfigured):
                SupabasePlanningReader(
                    user_id="authenticated-user",
                    access_token="verified-access-token",
                    supabase_url="https://project.supabase.co",
                    publishable_key=f"header.{payload}.signature",
                    client=client,
                )


class PlanningEndpointTests(unittest.TestCase):
    def test_requires_authentication(self) -> None:
        app = FastAPI()
        app.include_router(router)
        with TestClient(app) as client:
            response = client.get("/api/ai/planning?date=2026-09-28")
        self.assertEqual(response.status_code, 401)

    def test_ignores_forged_user_id_and_uses_verified_identity(self) -> None:
        class Reader:
            authenticated_user_id = "verified-user"

            async def read_schedule(self, requested_date: date) -> dict[str, object]:
                return {"date": requested_date.isoformat(), "owner": self.authenticated_user_id}

        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser("verified-user", "token")
        app.dependency_overrides[get_planning_reader] = lambda: Reader()
        with TestClient(app) as client:
            response = client.get("/api/ai/planning?date=2026-09-28&user_id=attacker")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["data"]["owner"], "verified-user")


class SupabaseAuthTests(unittest.TestCase):
    def test_identity_and_access_token_come_from_verified_bearer(self) -> None:
        response = httpx.Response(
            200,
            json={"id": "verified-user"},
            request=httpx.Request("GET", "https://project.supabase.co/auth/v1/user"),
        )
        config = {
            "SUPABASE_URL": "https://project.supabase.co",
            "SUPABASE_PUBLISHABLE_KEY": "public-key",
        }
        with patch("app.auth.local_env_value", side_effect=lambda name: config.get(name, "")), patch(
            "app.auth.httpx.get", return_value=response
        ) as request:
            identity = get_authenticated_user("Bearer verified-access-token")

        self.assertEqual(identity.user_id, "verified-user")
        self.assertEqual(identity.access_token, "verified-access-token")
        self.assertNotIn("verified-access-token", repr(identity))
        self.assertEqual(request.call_args.kwargs["headers"]["Authorization"], "Bearer verified-access-token")