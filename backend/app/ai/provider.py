import json
import logging
import os
from dataclasses import dataclass, field, replace
from typing import Mapping, Protocol, Sequence
from urllib.parse import quote

import httpx

from .context import AIModelContext

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AIToolSpec:
    name: str
    description: str
    parameters: Mapping[str, object]


@dataclass(frozen=True)
class AIToolCall:
    name: str
    arguments: Mapping[str, object]
    call_id: str | None = None


@dataclass(frozen=True)
class AIToolResult:
    name: str
    output: object
    arguments: Mapping[str, object] = field(default_factory=dict)
    call_id: str | None = None


@dataclass(frozen=True)
class ProviderFailure:
    provider: str
    error_code: str
    retryable: bool


@dataclass(frozen=True)
class AIProviderResult:
    message: str | None = None
    tool_call: AIToolCall | None = None
    provider_name: str | None = None
    provider_failures: tuple[ProviderFailure, ...] = ()


class AIProviderError(RuntimeError):
    def __init__(
        self,
        provider: str,
        error_code: str,
        *,
        retryable: bool,
        http_status: int | None = None,
        failures: Sequence[ProviderFailure] = (),
    ) -> None:
        self.provider = provider
        self.error_code = error_code
        self.retryable = retryable
        self.http_status = http_status
        self.failures = tuple(failures)
        super().__init__(f"{provider}:{error_code}")


class ProviderRouterError(AIProviderError):
    pass


class AIProviderNotConfigured(AIProviderError):
    def __init__(self) -> None:
        super().__init__("none", "provider_not_configured", retryable=False)


class AIProvider(Protocol):
    name: str

    async def generate(
        self,
        *,
        context: AIModelContext,
        message: str,
        tools: Sequence[AIToolSpec],
        tool_results: Sequence[AIToolResult],
    ) -> AIProviderResult: ...


class PlaceholderAIProvider:
    name = "placeholder"
    configured = True

    async def generate(
        self,
        *,
        context: AIModelContext,
        message: str,
        tools: Sequence[AIToolSpec],
        tool_results: Sequence[AIToolResult],
    ) -> AIProviderResult:
        raise AIProviderNotConfigured()


def _context_text(context: AIModelContext, provider: str) -> str | None:
    values = {
        "profile_preferences": context.profile_preferences,
        "temporary_context": context.temporary_context,
        "memory": context.memory,
    }
    values = {name: value for name, value in values.items() if value}
    if not values:
        return None
    try:
        serialized = json.dumps(values, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        raise AIProviderError(provider, "invalid_context", retryable=False) from None
    return f"Contexte utilisateur disponible : {serialized}"


def _json_text(value: object, provider: str, error_code: str) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        raise AIProviderError(provider, error_code, retryable=False) from None


def _gemini_schema(schema: Mapping[str, object]) -> dict[str, object]:
    type_names = {
        "array": "ARRAY",
        "boolean": "BOOLEAN",
        "integer": "INTEGER",
        "number": "NUMBER",
        "object": "OBJECT",
        "string": "STRING",
    }
    result: dict[str, object] = {}
    schema_type = schema.get("type")
    if isinstance(schema_type, str) and schema_type.lower() in type_names:
        result["type"] = type_names[schema_type.lower()]
    if isinstance(schema.get("description"), str):
        result["description"] = schema["description"]
    if isinstance(schema.get("enum"), list):
        result["enum"] = schema["enum"]
    properties = schema.get("properties")
    if isinstance(properties, Mapping):
        result["properties"] = {
            name: _gemini_schema(value)
            for name, value in properties.items()
            if isinstance(name, str) and isinstance(value, Mapping)
        }
    items = schema.get("items")
    if isinstance(items, Mapping):
        result["items"] = _gemini_schema(items)
    required = schema.get("required")
    if isinstance(required, list) and all(isinstance(name, str) for name in required):
        result["required"] = required
    return result


def _openai_messages(
    provider: str,
    context: AIModelContext,
    message: str,
    tool_results: Sequence[AIToolResult],
) -> list[dict[str, object]]:
    messages: list[dict[str, object]] = []
    system_context = _context_text(context, provider)
    if system_context:
        messages.append({"role": "system", "content": system_context})
    messages.append({"role": "user", "content": message})
    for index, result in enumerate(tool_results):
        call_id = result.call_id or f"study-os-tool-{index}"
        arguments = _json_text(result.arguments, provider, "invalid_tool_arguments")
        output = _json_text(result.output, provider, "invalid_tool_result")
        messages.append({
            "role": "assistant",
            "tool_calls": [{
                "id": call_id,
                "type": "function",
                "function": {"name": result.name, "arguments": arguments},
            }],
        })
        messages.append({"role": "tool", "tool_call_id": call_id, "content": output})
    return messages


class _HTTPProvider:
    name = "provider"

    def __init__(
        self,
        *,
        api_key: str | None,
        model: str | None,
        client: httpx.AsyncClient | None = None,
        timeout: float = 20,
    ) -> None:
        self._api_key = api_key.strip() if api_key and api_key.strip() else None
        self.model = model.strip() if model and model.strip() else None
        self._client = client
        self.timeout = timeout

    @property
    def configured(self) -> bool:
        return self._api_key is not None and self.model is not None

    async def _post_json(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        body: Mapping[str, object],
    ) -> dict[str, object]:
        try:
            if self._client is None:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    response = await client.post(url, headers=dict(headers), json=body)
            else:
                response = await self._client.post(url, headers=dict(headers), json=body)
        except httpx.TimeoutException:
            raise AIProviderError(self.name, "timeout", retryable=True) from None
        except httpx.RequestError:
            raise AIProviderError(self.name, "network_error", retryable=True) from None

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as error:
            status_code = error.response.status_code
            if status_code == 429:
                code, retryable = "rate_limited", True
            elif status_code == 402:
                code, retryable = "quota_exceeded", True
            elif status_code in (408, 425) or status_code >= 500:
                code, retryable = "provider_unavailable", True
            elif status_code in (401, 403):
                code, retryable = "provider_authentication_failed", False
            elif status_code in (400, 413, 422):
                code, retryable = "invalid_request", False
            elif status_code == 404:
                code, retryable = "model_not_found", False
            else:
                code, retryable = "provider_rejected_request", False
            raise AIProviderError(
                self.name,
                code,
                retryable=retryable,
                http_status=status_code,
            ) from None

        try:
            payload = response.json()
        except ValueError:
            raise AIProviderError(self.name, "invalid_provider_response", retryable=True) from None
        if not isinstance(payload, dict):
            raise AIProviderError(self.name, "invalid_provider_response", retryable=True)
        return payload

    def _require_configuration(self) -> None:
        if not self.configured:
            raise AIProviderError(self.name, "missing_configuration", retryable=False)


class _OpenAICompatibleProvider(_HTTPProvider):
    endpoint = ""

    async def generate(
        self,
        *,
        context: AIModelContext,
        message: str,
        tools: Sequence[AIToolSpec],
        tool_results: Sequence[AIToolResult],
    ) -> AIProviderResult:
        self._require_configuration()
        body: dict[str, object] = {
            "model": self.model,
            "messages": _openai_messages(self.name, context, message, tool_results),
        }
        if tools:
            body["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": dict(tool.parameters),
                    },
                }
                for tool in tools
            ]
            body["tool_choice"] = "auto"
        payload = await self._post_json(
            self.endpoint,
            headers={"Authorization": f"Bearer {self._api_key}"},
            body=body,
        )
        try:
            choice = payload["choices"][0]
            response_message = choice["message"]
            calls = response_message.get("tool_calls") or []
            if calls:
                call = calls[0]
                function = call["function"]
                raw_arguments = function["arguments"]
                arguments = json.loads(raw_arguments) if isinstance(raw_arguments, str) else raw_arguments
                if not isinstance(arguments, dict):
                    raise ValueError
                return AIProviderResult(
                    tool_call=AIToolCall(
                        name=str(function["name"]),
                        arguments=arguments,
                        call_id=str(call.get("id") or "") or None,
                    )
                )
            content = response_message.get("content")
        except (KeyError, IndexError, TypeError, ValueError):
            raise AIProviderError(self.name, "invalid_provider_response", retryable=True) from None
        if not isinstance(content, str):
            raise AIProviderError(self.name, "invalid_provider_response", retryable=True)
        return AIProviderResult(message=content)


class GroqProvider(_OpenAICompatibleProvider):
    name = "groq"
    endpoint = "https://api.groq.com/openai/v1/chat/completions"

    @classmethod
    def from_environment(cls, *, client: httpx.AsyncClient | None = None) -> "GroqProvider":
        return cls(
            api_key=os.getenv("GROQ_API_KEY"),
            model=os.getenv("GROQ_MODEL"),
            client=client,
        )


class OpenRouterProvider(_OpenAICompatibleProvider):
    name = "openrouter"
    endpoint = "https://openrouter.ai/api/v1/chat/completions"

    @classmethod
    def from_environment(cls, *, client: httpx.AsyncClient | None = None) -> "OpenRouterProvider":
        return cls(
            api_key=os.getenv("OPENROUTER_API_KEY"),
            model=os.getenv("OPENROUTER_MODEL"),
            client=client,
        )


class GeminiProvider(_HTTPProvider):
    name = "gemini"
    endpoint = "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent"

    @classmethod
    def from_environment(cls, *, client: httpx.AsyncClient | None = None) -> "GeminiProvider":
        return cls(
            api_key=os.getenv("GEMINI_API_KEY"),
            model=os.getenv("GEMINI_MODEL"),
            client=client,
        )

    async def generate(
        self,
        *,
        context: AIModelContext,
        message: str,
        tools: Sequence[AIToolSpec],
        tool_results: Sequence[AIToolResult],
    ) -> AIProviderResult:
        self._require_configuration()
        contents: list[dict[str, object]] = [{"role": "user", "parts": [{"text": message}]}]
        for result in tool_results:
            arguments_text = _json_text(result.arguments, self.name, "invalid_tool_arguments")
            output_text = _json_text(result.output, self.name, "invalid_tool_result")
            contents.append({
                "role": "model",
                "parts": [{
                    "functionCall": {
                        "name": result.name,
                        "args": json.loads(arguments_text),
                    }
                }],
            })
            contents.append({
                "role": "user",
                "parts": [{
                    "functionResponse": {
                        "name": result.name,
                        "response": {"result": json.loads(output_text)},
                    }
                }],
            })

        body: dict[str, object] = {"contents": contents}
        system_context = _context_text(context, self.name)
        if system_context:
            body["systemInstruction"] = {"parts": [{"text": system_context}]}
        if tools:
            body["tools"] = [{
                "functionDeclarations": [
                    {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": _gemini_schema(tool.parameters),
                    }
                    for tool in tools
                ]
            }]

        model_path = quote(self.model or "", safe="-._")
        payload = await self._post_json(
            self.endpoint.format(model_path),
            headers={"x-goog-api-key": self._api_key or ""},
            body=body,
        )
        try:
            candidate = payload["candidates"][0]
            if candidate.get("finishReason") == "SAFETY":
                raise AIProviderError(self.name, "content_blocked", retryable=False)
            parts = candidate["content"]["parts"]
            function_call = next((part["functionCall"] for part in parts if "functionCall" in part), None)
            if function_call is not None:
                arguments = function_call.get("args", {})
                if not isinstance(arguments, dict):
                    raise ValueError
                return AIProviderResult(
                    tool_call=AIToolCall(name=str(function_call["name"]), arguments=arguments)
                )
            text = "".join(str(part["text"]) for part in parts if isinstance(part.get("text"), str))
        except AIProviderError:
            raise
        except (KeyError, IndexError, TypeError, ValueError):
            raise AIProviderError(self.name, "invalid_provider_response", retryable=True) from None
        return AIProviderResult(message=text)


class ProviderRouter:
    def __init__(
        self,
        providers: Sequence[AIProvider] | None = None,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.providers = tuple(providers) if providers is not None else (
            GroqProvider.from_environment(client=client),
            GeminiProvider.from_environment(client=client),
            OpenRouterProvider.from_environment(client=client),
        )

    @classmethod
    def from_environment(cls, *, client: httpx.AsyncClient | None = None) -> "ProviderRouter":
        return cls(client=client)

    async def generate(
        self,
        *,
        context: AIModelContext,
        message: str,
        tools: Sequence[AIToolSpec],
        tool_results: Sequence[AIToolResult],
    ) -> AIProviderResult:
        failures: list[ProviderFailure] = []
        for provider in self.providers:
            name = getattr(provider, "name", provider.__class__.__name__.lower())
            if not getattr(provider, "configured", True):
                failures.append(ProviderFailure(name, "missing_configuration", False))
                logger.info("provider=%s status=disabled", name)
                continue
            try:
                result = await provider.generate(
                    context=context,
                    message=message,
                    tools=tools,
                    tool_results=tool_results,
                )
            except AIProviderError as error:
                failures.extend((*error.failures, ProviderFailure(name, error.error_code, error.retryable)))
                if error.error_code in ("rate_limited", "quota_exceeded"):
                    status = error.error_code
                else:
                    status = "unavailable" if error.retryable else "error"
                logger.info("provider=%s status=%s", name, status)
                if not error.retryable:
                    raise ProviderRouterError(
                        name,
                        error.error_code,
                        retryable=False,
                        http_status=error.http_status,
                        failures=failures,
                    ) from None
                continue

            logger.info("provider=%s status=success", name)
            return replace(
                result,
                provider_name=name,
                provider_failures=tuple(failures) + result.provider_failures,
            )

        error_code = "no_provider_configured" if failures and all(
            failure.error_code == "missing_configuration" for failure in failures
        ) else "all_providers_failed"
        raise ProviderRouterError(
            "router",
            error_code,
            retryable=False,
            failures=failures,
        )