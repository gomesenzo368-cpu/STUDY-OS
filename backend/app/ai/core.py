from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
import logging
from typing import Literal

from .context import AIContext
from .provider import (
    AIProvider,
    AIProviderError,
    AIProviderNotConfigured,
    AIToolResult,
    AIToolSpec,
    ProviderFailure,
    ProviderRouter,
)

ToolHandler = Callable[[AIContext, Mapping[str, object]], Awaitable[object]]
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AuthorizedTool:
    spec: AIToolSpec
    handler: ToolHandler


@dataclass(frozen=True)
class AIResponse:
    status: Literal["completed", "unavailable", "error"]
    message: str | None = None
    error_code: str | None = None
    data: object | None = None
    provider: str | None = None
    provider_failures: tuple[ProviderFailure, ...] = ()


class AICore:
    def __init__(
        self,
        provider: AIProvider | None = None,
        tools: Sequence[AuthorizedTool] = (),
        max_tool_calls: int = 5,
    ) -> None:
        self.provider = provider or ProviderRouter.from_environment()
        self.tools = {tool.spec.name: tool for tool in tools}
        self.max_tool_calls = max_tool_calls

    async def execute_tool(
        self,
        tool_name: str,
        arguments: Mapping[str, object],
        context: AIContext,
    ) -> AIResponse:
        tool = self.tools.get(tool_name)
        if tool is None:
            return AIResponse(status="error", error_code="tool_not_authorized")
        output = await tool.handler(context, arguments)
        return AIResponse(status="completed", data=output)

    async def respond(self, message: str, context: AIContext) -> AIResponse:
        tool_results: list[AIToolResult] = []
        tool_specs = [tool.spec for tool in self.tools.values()]
        provider_failures: list[ProviderFailure] = []
        logger.info(
            "ai_core event=respond_started message_length=%d available_tools=%d",
            len(message),
            len(tool_specs),
        )

        for _ in range(self.max_tool_calls + 1):
            if tool_results:
                logger.info(
                    "ai_core event=tool_results_attached result_count=%d",
                    len(tool_results),
                )
            else:
                logger.info("ai_core event=provider_request result_count=0")
            try:
                result = await self.provider.generate(
                    context=context.for_provider(),
                    message=message,
                    tools=tool_specs,
                    tool_results=tool_results,
                )
            except AIProviderNotConfigured as error:
                logger.warning("ai_core event=final_response status=unavailable error_code=%s", error.error_code)
                return AIResponse(status="unavailable", error_code=error.error_code)
            except AIProviderError as error:
                status = "unavailable" if error.error_code == "no_provider_configured" else "error"
                logger.warning(
                    "ai_core event=final_response status=%s provider=%s error_code=%s",
                    status,
                    error.provider if error.provider in {"groq", "gemini", "openrouter", "router"} else "unknown",
                    error.error_code,
                )
                return AIResponse(
                    status=status,
                    error_code=error.error_code,
                    provider=error.provider,
                    provider_failures=tuple(provider_failures) + error.failures,
                )

            provider_failures.extend(result.provider_failures)

            if result.tool_call is None:
                logger.info(
                    "ai_core event=model_decision decision=no_tool provider=%s",
                    result.provider_name if result.provider_name in {"groq", "gemini", "openrouter"} else "unknown",
                )
                if result.message is None:
                    logger.warning("ai_core event=final_response status=error error_code=invalid_provider_response")
                    return AIResponse(status="error", error_code="invalid_provider_response")
                logger.info(
                    "ai_core event=final_response status=completed provider=%s message_length=%d",
                    result.provider_name if result.provider_name in {"groq", "gemini", "openrouter"} else "unknown",
                    len(result.message),
                )
                return AIResponse(
                    status="completed",
                    message=result.message,
                    provider=result.provider_name,
                    provider_failures=tuple(provider_failures),
                )

            authorized_tool = self.tools.get(result.tool_call.name)
            safe_tool_name = result.tool_call.name if authorized_tool is not None else "unrecognized"
            safe_argument_names = sorted(set(result.tool_call.arguments).intersection({"date", "dates"}))
            logger.info(
                "ai_core event=model_decision decision=tool_requested tool=%s argument_fields=%s",
                safe_tool_name,
                ",".join(safe_argument_names) or "none",
            )
            if authorized_tool is None:
                logger.warning("ai_core event=tool_execution status=blocked reason=not_allowlisted")
            else:
                logger.info("ai_core event=tool_execution status=started tool=%s", safe_tool_name)
            try:
                tool_response = await self.execute_tool(result.tool_call.name, result.tool_call.arguments, context)
            except Exception as error:
                logger.warning(
                    "ai_core event=tool_execution status=failed tool=%s error_type=%s",
                    safe_tool_name,
                    type(error).__name__,
                )
                raise
            if tool_response.status != "completed":
                logger.warning(
                    "ai_core event=tool_execution status=blocked tool=%s error_code=%s",
                    safe_tool_name,
                    tool_response.error_code or "unknown",
                )
                return tool_response
            result_count = _tool_result_count(tool_response.data)
            logger.info(
                "ai_core event=tool_result_ready tool=%s result_count=%d",
                safe_tool_name,
                result_count,
            )
            tool_results.append(AIToolResult(
                name=result.tool_call.name,
                output=tool_response.data,
                arguments=result.tool_call.arguments,
                call_id=result.tool_call.call_id,
            ))

        logger.warning("ai_core event=final_response status=error error_code=tool_call_limit_reached")
        return AIResponse(status="error", error_code="tool_call_limit_reached")


def _tool_result_count(data: object) -> int:
    if not isinstance(data, Mapping):
        return 0
    events = data.get("events")
    if isinstance(events, list):
        return len(events)
    schedules = data.get("schedules")
    if isinstance(schedules, list):
        return sum(
            len(schedule.get("events", []))
            for schedule in schedules
            if isinstance(schedule, Mapping) and isinstance(schedule.get("events"), list)
        )
    return 0