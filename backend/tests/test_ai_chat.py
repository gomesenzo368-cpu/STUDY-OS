import unittest
from datetime import date
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.ai.api import get_planning_reader, router
from app.ai.context import AIModelContext
from app.ai.provider import AIProviderError, AIProviderResult, AIToolCall, ProviderRouter
from app.auth import AuthenticatedUser, get_authenticated_user


class FakeChatProvider:
    name = "groq"
    configured = True

    def __init__(self, *, error: AIProviderError | None = None) -> None:
        self.error = error
        self.message: str | None = None
        self.context: AIModelContext | None = None

    async def generate(self, *, context, message, tools, tool_results):
        self.message = message
        self.context = context
        if self.error is not None:
            raise self.error
        return AIProviderResult(message="Bonjour !", provider_name=self.name)


class FakePlanningReader:
    authenticated_user_id = "verified-user-id"

    def __init__(self) -> None:
        self.requested_dates: list[date] = []

    async def read_schedule(self, requested_date: date) -> dict[str, object]:
        self.requested_dates.append(requested_date)
        return {
            "date": requested_date.isoformat(),
            "events": [{"title": "Mathématiques", "start_time": "09:00", "end_time": "10:00"}],
        }


class PlanningConversationProvider:
    name = "groq"
    configured = True

    def __init__(self, arguments: dict[str, object]) -> None:
        self.arguments = arguments
        self.calls: list[dict[str, object]] = []

    async def generate(self, *, context, message, tools, tool_results):
        self.calls.append({"context": context, "message": message, "tools": tools, "tool_results": tool_results})
        if not tool_results:
            return AIProviderResult(tool_call=AIToolCall("get_schedule", self.arguments, "call-planning"))
        return AIProviderResult(message="Tu as mathématiques lundi à 09:00.", provider_name=self.name)


class AIChatEndpointTests(unittest.TestCase):
    def setUp(self) -> None:
        self.app = FastAPI()
        self.app.include_router(router)
        self.app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser(
            "verified-user-id",
            "mock-supabase-token",
        )
        self.reader = FakePlanningReader()
        self.app.dependency_overrides[get_planning_reader] = lambda: self.reader
        self.client = TestClient(self.app)

    def tearDown(self) -> None:
        self.client.close()
        self.app.dependency_overrides.clear()

    def test_authenticated_user_message_reaches_ai_core(self) -> None:
        provider = FakeChatProvider()
        with patch("app.ai.core.ProviderRouter.from_environment", return_value=ProviderRouter([provider])):
            response = self.client.post(
                "/api/ai/chat",
                headers={"Authorization": "Bearer mock-supabase-token"},
                json={"message": "Bonjour"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["status"], "completed")
        self.assertEqual(body["message"], "Bonjour !")
        self.assertEqual(body["provider"], "groq")
        self.assertEqual(provider.message, "Bonjour")
        self.assertFalse(hasattr(provider.context, "user_id"))
        self.assertNotIn("mock-supabase-token", repr(provider.context))

    def test_unauthenticated_request_returns_401(self) -> None:
        self.app.dependency_overrides.clear()
        response = self.client.post("/api/ai/chat", json={"message": "Bonjour"})
        self.assertEqual(response.status_code, 401)

    def test_client_cannot_supply_user_id(self) -> None:
        response = self.client.post(
            "/api/ai/chat",
            json={"message": "Bonjour", "user_id": "other-user-id"},
        )
        self.assertEqual(response.status_code, 422)

    def test_provider_error_has_safe_structured_response(self) -> None:
        provider = FakeChatProvider(error=AIProviderError(
            "groq",
            "provider_unavailable",
            retryable=False,
        ))
        with patch("app.ai.core.ProviderRouter.from_environment", return_value=ProviderRouter([provider])):
            response = self.client.post("/api/ai/chat", json={"message": "Question privée"})

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["status"], "error")
        self.assertEqual(response.json()["error_code"], "provider_unavailable")
        self.assertEqual(response.json()["provider"], "groq")
        self.assertNotIn("mock-supabase-token", response.text)
        self.assertNotIn("Question privée", response.text)

    def test_provider_logs_exclude_message_and_credentials(self) -> None:
        provider = FakeChatProvider(error=AIProviderError(
            "groq",
            "provider_unavailable",
            retryable=False,
        ))
        with patch("app.ai.core.ProviderRouter.from_environment", return_value=ProviderRouter([provider])):
            with self.assertLogs("app.ai.provider", level="INFO") as captured:
                self.client.post(
                    "/api/ai/chat",
                    headers={"Authorization": "Bearer mock-supabase-token"},
                    json={"message": "private-message-sentinel"},
                )

        logs = "\n".join(captured.output)
        self.assertIn("provider=groq status=error", logs)
        self.assertNotIn("private-message-sentinel", logs)
        self.assertNotIn("mock-supabase-token", logs)
        self.assertNotIn("Bearer ", logs)

    def test_planning_question_calls_tool_and_returns_result_to_model(self) -> None:
        provider = PlanningConversationProvider({"date": "2026-09-28"})
        with patch("app.ai.core.ProviderRouter.from_environment", return_value=ProviderRouter([provider])):
            with self.assertLogs("app.ai.provider", level="INFO") as captured:
                response = self.client.post(
                    "/api/ai/chat",
                    headers={"Authorization": "Bearer mock-supabase-token"},
                    json={"message": "Quels cours ai-je lundi prochain ?"},
                )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["message"], "Tu as mathématiques lundi à 09:00.")
        self.assertEqual(response.json()["provider"], "groq")
        self.assertEqual(self.reader.requested_dates, [date(2026, 9, 28)])
        self.assertEqual(len(provider.calls), 2)
        available_tools = provider.calls[0]["tools"]
        self.assertEqual([tool.name for tool in available_tools], ["get_schedule"])
        self.assertNotIn("user_id", available_tools[0].parameters["properties"])
        self.assertEqual(provider.calls[1]["tool_results"][0].name, "get_schedule")
        self.assertEqual(provider.calls[1]["tool_results"][0].output["events"][0]["title"], "Mathématiques")
        self.assertFalse(hasattr(provider.calls[0]["context"], "user_id"))
        logs = "\n".join(captured.output)
        self.assertNotIn("mock-supabase-token", logs)
        self.assertNotIn("Bearer ", logs)

    def test_week_request_reads_bounded_dates_in_one_tool_call(self) -> None:
        dates = [f"2026-09-{day:02d}" for day in range(28, 30)] + [f"2026-10-0{day}" for day in range(1, 6)]
        provider = PlanningConversationProvider({"dates": dates})
        with patch("app.ai.core.ProviderRouter.from_environment", return_value=ProviderRouter([provider])):
            response = self.client.post(
                "/api/ai/chat",
                json={"message": "Quels sont mes cours cette semaine ?"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.reader.requested_dates, [date.fromisoformat(value) for value in dates])
        self.assertEqual(len(provider.calls[1]["tool_results"][0].output["schedules"]), 7)

    def test_general_question_does_not_call_planning_tool(self) -> None:
        provider = FakeChatProvider()
        with patch("app.ai.core.ProviderRouter.from_environment", return_value=ProviderRouter([provider])):
            response = self.client.post("/api/ai/chat", json={"message": "Bonjour, peux-tu m'aider ?"})

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["message"], "Bonjour !")
        self.assertEqual(self.reader.requested_dates, [])
        self.assertEqual(len(provider.context.temporary_context), 2)

    def test_model_cannot_select_another_user_for_planning_tool(self) -> None:
        provider = PlanningConversationProvider({"date": "2026-09-28", "user_id": "other-user"})
        with patch("app.ai.core.ProviderRouter.from_environment", return_value=ProviderRouter([provider])):
            response = self.client.post("/api/ai/chat", json={"message": "Quels cours ai-je lundi ?"})

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["error_code"], "assistant_request_failed")
        self.assertEqual(self.reader.requested_dates, [])


if __name__ == "__main__":
    unittest.main()
