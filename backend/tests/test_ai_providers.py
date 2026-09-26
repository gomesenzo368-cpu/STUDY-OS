import json
import os
import unittest
from collections.abc import Sequence
from unittest.mock import patch

import httpx

from app.ai import AICore, AIContext, AIProviderError, GeminiProvider, GroqProvider, OpenRouterProvider, ProviderRouter
from app.ai.core import AuthorizedTool
from app.ai.provider import (
    AIProviderResult,
    AIToolCall,
    AIToolResult,
    AIToolSpec,
    ProviderRouterError,
)


class FakeProvider:
    def __init__(self, name: str, outcomes: Sequence[object], *, configured: bool = True) -> None:
        self.name = name
        self.configured = configured
        self.outcomes = list(outcomes)
        self.calls = 0

    async def generate(self, *, context, message, tools, tool_results):
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def provider_error(name: str, code: str = "rate_limited", *, retryable: bool = True) -> AIProviderError:
    return AIProviderError(name, code, retryable=retryable)


def generate(router: ProviderRouter, *, message: str = "question confidentielle", tool_results=()):
    return router.generate(
        context=AIContext(user_id="internal-user").for_provider(),
        message=message,
        tools=(),
        tool_results=tool_results,
    )


class ProviderRouterTests(unittest.IsolatedAsyncioTestCase):
    async def test_groq_success_skips_remaining_providers(self) -> None:
        groq = FakeProvider("groq", [AIProviderResult(message="Groq")])
        gemini = FakeProvider("gemini", [AIProviderResult(message="Gemini")])
        router = ProviderRouter([groq, gemini])

        result = await generate(router)

        self.assertEqual(result.message, "Groq")
        self.assertEqual(result.provider_name, "groq")
        self.assertEqual((groq.calls, gemini.calls), (1, 0))

    async def test_rate_limit_falls_back_to_gemini(self) -> None:
        groq = FakeProvider("groq", [provider_error("groq")])
        gemini = FakeProvider("gemini", [AIProviderResult(message="Gemini")])

        result = await generate(ProviderRouter([groq, gemini]))

        self.assertEqual(result.provider_name, "gemini")
        self.assertEqual(result.provider_failures[0].error_code, "rate_limited")
        self.assertEqual((groq.calls, gemini.calls), (1, 1))

    async def test_groq_and_gemini_fail_then_openrouter_succeeds(self) -> None:
        providers = [
            FakeProvider("groq", [provider_error("groq")]),
            FakeProvider("gemini", [provider_error("gemini", "provider_unavailable")]),
            FakeProvider("openrouter", [AIProviderResult(message="OpenRouter")]),
        ]

        result = await generate(ProviderRouter(providers))

        self.assertEqual(result.message, "OpenRouter")
        self.assertEqual(result.provider_name, "openrouter")
        self.assertEqual([failure.provider for failure in result.provider_failures], ["groq", "gemini"])

    async def test_all_failures_are_structured_by_core(self) -> None:
        router = ProviderRouter([
            FakeProvider("groq", [provider_error("groq")]),
            FakeProvider("gemini", [provider_error("gemini", "provider_unavailable")]),
            FakeProvider("openrouter", [provider_error("openrouter", "timeout")]),
        ])

        response = await AICore(provider=router).respond("question", AIContext(user_id="user"))

        self.assertEqual(response.status, "error")
        self.assertEqual(response.error_code, "all_providers_failed")
        self.assertEqual([failure.provider for failure in response.provider_failures], ["groq", "gemini", "openrouter"])

    async def test_missing_keys_disable_providers_without_crashing(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            router = ProviderRouter.from_environment()
            self.assertEqual([provider.name for provider in router.providers], ["groq", "gemini", "openrouter"])
            response = await AICore(provider=router).respond("question", AIContext(user_id="user"))

        self.assertEqual(response.status, "unavailable")
        self.assertEqual(response.error_code, "no_provider_configured")
        self.assertEqual([failure.error_code for failure in response.provider_failures], [
            "missing_configuration", "missing_configuration", "missing_configuration",
        ])

    async def test_non_recoverable_error_does_not_fallback(self) -> None:
        groq = FakeProvider("groq", [provider_error("groq", "invalid_request", retryable=False)])
        gemini = FakeProvider("gemini", [AIProviderResult(message="must not run")])

        with self.assertRaises(ProviderRouterError) as raised:
            await generate(ProviderRouter([groq, gemini]))

        self.assertEqual(raised.exception.error_code, "invalid_request")
        self.assertEqual((groq.calls, gemini.calls), (1, 0))

    async def test_logs_contain_only_provider_statuses(self) -> None:
        groq = FakeProvider("groq", [provider_error("groq")])
        gemini = FakeProvider("gemini", [AIProviderResult(message="réponse")])
        router = ProviderRouter([groq, gemini])

        with self.assertLogs("app.ai.provider", level="INFO") as captured:
            await generate(router, message="prompt-prive-test")

        logs = "\n".join(captured.output)
        self.assertIn("provider=groq status=rate_limited", logs)
        self.assertIn("provider=gemini status=success", logs)
        self.assertNotIn("prompt-prive-test", logs)
        self.assertNotIn("mock-api-key", logs)
        self.assertNotIn("mock-supabase-token", logs)

    async def test_core_preserves_tool_results_across_fallback(self) -> None:
        async def read_tool(context, arguments):
            return {"date": arguments["date"], "items": ["session"]}

        groq = FakeProvider("groq", [
            AIProviderResult(tool_call=AIToolCall("get_schedule", {"date": "2026-09-28"}, "call-1")),
            provider_error("groq"),
        ])

        class GeminiAfterTool(FakeProvider):
            async def generate(self, *, context, message, tools, tool_results):
                self.calls += 1
                self.assert_tool_result(tool_results)
                return AIProviderResult(message="Planning résumé", provider_name="gemini")

            def assert_tool_result(self, tool_results):
                if not tool_results:
                    raise AssertionError("tool result was not sent to fallback provider")
                result = tool_results[0]
                if result.name != "get_schedule" or result.arguments != {"date": "2026-09-28"} or result.call_id != "call-1":
                    raise AssertionError("tool call history was not preserved")

        gemini = GeminiAfterTool("gemini", [])
        core = AICore(
            provider=ProviderRouter([groq, gemini]),
            tools=[AuthorizedTool(AIToolSpec("get_schedule", "Read schedule", {"type": "object"}), read_tool)],
        )

        response = await core.respond("Quel est mon planning ?", AIContext(user_id="internal-user"))

        self.assertEqual(response.status, "completed")
        self.assertEqual(response.message, "Planning résumé")
        self.assertEqual(response.provider, "gemini")
        self.assertEqual(response.provider_failures[0].provider, "groq")


class ProviderAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_groq_translates_tool_schema_and_response(self) -> None:
        requests = []

        def respond(request):
            requests.append(request)
            return httpx.Response(200, json={"choices": [{"message": {
                "tool_calls": [{"id": "call-7", "function": {"name": "get_schedule", "arguments": "{\"date\":\"2026-09-28\"}"}}],
            }}]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            provider = GroqProvider(api_key="mock-api-key", model="configured-model", client=client)
            result = await provider.generate(
                context=AIContext(user_id="never-sent").for_provider(),
                message="Planning ?",
                tools=[AIToolSpec("get_schedule", "Read schedule", {"type": "object"})],
                tool_results=(),
            )

        request = requests[0]
        body = json.loads(request.content)
        self.assertEqual(request.url.host, "api.groq.com")
        self.assertEqual(request.headers["authorization"], "Bearer mock-api-key")
        self.assertEqual(body["model"], "configured-model")
        self.assertEqual(body["tools"][0]["function"]["name"], "get_schedule")
        self.assertNotIn("never-sent", request.content.decode())
        self.assertEqual(result.tool_call.call_id, "call-7")
        self.assertEqual(result.tool_call.arguments["date"], "2026-09-28")

    async def test_gemini_translates_context_and_function_call(self) -> None:
        requests = []

        def respond(request):
            requests.append(request)
            return httpx.Response(200, json={"candidates": [{"content": {"parts": [{
                "functionCall": {"name": "get_schedule", "args": {"date": "2026-09-28"}},
            }]}}]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            provider = GeminiProvider(api_key="mock-api-key", model="replaceable-model", client=client)
            result = await provider.generate(
                context=AIContext(user_id="never-sent", temporary_context={"locale": "fr"}).for_provider(),
                message="Planning ?",
                tools=[AIToolSpec("get_schedule", "Read schedule", {
                    "type": "object",
                    "properties": {"date": {"type": "string", "format": "date"}},
                    "required": ["date"],
                    "additionalProperties": False,
                })],
                tool_results=(),
            )

        request = requests[0]
        body = json.loads(request.content)
        self.assertEqual(request.url.path, "/v1beta/models/replaceable-model:generateContent")
        self.assertEqual(request.headers["x-goog-api-key"], "mock-api-key")
        self.assertNotIn("mock-api-key", str(request.url))
        self.assertEqual(body["tools"][0]["functionDeclarations"][0]["name"], "get_schedule")
        parameters = body["tools"][0]["functionDeclarations"][0]["parameters"]
        self.assertEqual(parameters["type"], "OBJECT")
        self.assertEqual(parameters["properties"]["date"]["type"], "STRING")
        self.assertNotIn("additionalProperties", parameters)
        self.assertIn("locale", body["systemInstruction"]["parts"][0]["text"])
        self.assertNotIn("never-sent", request.content.decode())
        self.assertEqual(result.tool_call.arguments["date"], "2026-09-28")

    async def test_openrouter_uses_configured_model_and_compatible_format(self) -> None:
        requests = []

        def respond(request):
            requests.append(request)
            return httpx.Response(200, json={"choices": [{"message": {"content": "OpenRouter"}}]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            provider = OpenRouterProvider(api_key="mock-api-key", model="replaceable/model-id", client=client)
            result = await provider.generate(
                context=AIContext(user_id="internal").for_provider(),
                message="Question",
                tools=(),
                tool_results=(),
            )

        self.assertEqual(requests[0].url.host, "openrouter.ai")
        self.assertEqual(json.loads(requests[0].content)["model"], "replaceable/model-id")
        self.assertEqual(result.message, "OpenRouter")

    async def test_http_rate_limit_is_classified_without_body_or_key_leaks(self) -> None:
        secret = "mock-api-key"
        private_prompt = "prompt-prive-test"

        def respond(request):
            return httpx.Response(429, json={"error": f"{secret} {private_prompt}"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            provider = GroqProvider(api_key=secret, model="configured-model", client=client)
            with self.assertRaises(AIProviderError) as raised:
                await provider.generate(
                    context=AIContext(user_id="internal").for_provider(),
                    message=private_prompt,
                    tools=(),
                    tool_results=(),
                )

        self.assertEqual(raised.exception.error_code, "rate_limited")
        self.assertTrue(raised.exception.retryable)
        self.assertNotIn(secret, str(raised.exception))
        self.assertNotIn(private_prompt, str(raised.exception))

    async def test_http_quota_exhaustion_is_recoverable(self) -> None:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda request: httpx.Response(402, json={"error": "quota exceeded"}))
        ) as client:
            provider = OpenRouterProvider(api_key="mock-api-key", model="configured-model", client=client)
            with self.assertRaises(AIProviderError) as raised:
                await provider.generate(
                    context=AIContext(user_id="internal").for_provider(),
                    message="Question",
                    tools=(),
                    tool_results=(),
                )

        self.assertEqual(raised.exception.error_code, "quota_exceeded")
        self.assertTrue(raised.exception.retryable)


if __name__ == "__main__":
    unittest.main()
