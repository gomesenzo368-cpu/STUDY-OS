from collections.abc import Mapping
import base64
import binascii
from datetime import date as Date, timedelta
import json
import logging
from typing import Protocol

import httpx

from ..context import AIContext
from ..core import AuthorizedTool
from ..provider import AIToolSpec

logger = logging.getLogger(__name__)


class PlanningIntegrationNotConfigured(RuntimeError):
    """Aucun lecteur Planning Supabase authentifié n'est injecté."""


class PlanningAccessDenied(PermissionError):
    """Le lecteur Planning n'est pas lié à l'utilisateur demandé."""


class PlanningDataSourceUnavailable(RuntimeError):
    """Supabase n'a pas pu fournir les données Planning."""


class AuthenticatedPlanningReader(Protocol):
    @property
    def authenticated_user_id(self) -> str: ...

    async def read_schedule(self, schedule_date: Date) -> Mapping[str, object]: ...


def _is_service_role_key(key: str) -> bool:
    if key.startswith("sb_secret_"):
        return True
    parts = key.split(".")
    if len(parts) != 3:
        return False
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload))
    except (ValueError, binascii.Error):
        return False
    return isinstance(claims, dict) and claims.get("role") == "service_role"


class SupabasePlanningReader:
    def __init__(
        self,
        *,
        user_id: str,
        access_token: str,
        supabase_url: str,
        publishable_key: str,
        client: httpx.AsyncClient,
    ) -> None:
        if not user_id or not access_token or not supabase_url or not publishable_key:
            raise PlanningIntegrationNotConfigured("Configuration Supabase Planning incomplète.")
        if _is_service_role_key(publishable_key):
            raise PlanningIntegrationNotConfigured("Une clé publique Supabase est requise pour respecter RLS.")
        self.authenticated_user_id = user_id
        self._access_token = access_token
        self._supabase_url = supabase_url.rstrip("/")
        self._publishable_key = publishable_key
        self._client = client

    async def _select(
        self,
        table: str,
        columns: str,
        filters: Mapping[str, str],
        *,
        order: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, object]]:
        params = {"select": columns, **filters}
        if order is not None:
            params["order"] = order
        if limit is not None:
            params["limit"] = str(limit)
        try:
            response = await self._client.get(
                f"{self._supabase_url}/rest/v1/{table}",
                params=params,
                headers={
                    "apikey": self._publishable_key,
                    "Authorization": f"Bearer {self._access_token}",
                },
            )
            response.raise_for_status()
            rows = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise PlanningDataSourceUnavailable("Lecture Planning Supabase impossible.") from error
        if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
            raise PlanningDataSourceUnavailable("Réponse Planning Supabase invalide.")
        return rows

    async def read_schedule(self, schedule_date: Date) -> Mapping[str, object]:
        date_key = schedule_date.isoformat()
        user_filter = {"user_id": f"eq.{self.authenticated_user_id}"}
        years = await self._select(
            "planning_years",
            "id,name,starts_on,ends_on,time_zone",
            {
                **user_filter,
                "starts_on": f"lte.{date_key}",
                "ends_on": f"gte.{date_key}",
            },
            order="starts_on.desc,id.desc",
            limit=1,
        )
        if not years:
            return {"date": date_key, "school_year": None, "calendar_blocks": [], "events": []}

        year = years[0]
        year_id = year["id"]
        blocks = await self._select(
            "planning_calendar_blocks",
            "id,kind,name,starts_on,ends_on,description",
            {
                **user_filter,
                "year_id": f"eq.{year_id}",
                "starts_on": f"lte.{date_key}",
                "ends_on": f"gte.{date_key}",
            },
            order="starts_on.asc,id.asc",
        )
        series = await self._select(
            "planning_series",
            "id,year_id,entry_type,title,subject_id,teacher,room,day_of_week,recurrence,week_pattern,starts_on,ends_on,start_time,end_time,color_key,icon_key,status",
            {**user_filter, "year_id": f"eq.{year_id}"},
            order="day_of_week.asc,start_time.asc",
        )
        exceptions: list[dict[str, object]] = []
        if series:
            series_ids = ",".join(str(row["id"]) for row in series)
            exceptions = await self._select(
                "planning_exceptions",
                "id,series_id,occurrence_date,status,override_date,overrides",
                {**user_filter, "series_id": f"in.({series_ids})"},
                order="occurrence_date.asc",
            )

        return _schedule_for_date(schedule_date, year, blocks, series, exceptions)


def _schedule_for_date(
    schedule_date: Date,
    year: Mapping[str, object],
    blocks: list[dict[str, object]],
    series: list[dict[str, object]],
    exceptions: list[dict[str, object]],
) -> Mapping[str, object]:
    date_key = schedule_date.isoformat()
    year_start = Date.fromisoformat(str(year["starts_on"]))
    calendar_blocks = [
        {
            key: block.get(key)
            for key in ("id", "kind", "name", "starts_on", "ends_on", "description")
        }
        for block in blocks
    ]
    exceptions_by_series: dict[object, list[dict[str, object]]] = {}
    for exception in exceptions:
        exceptions_by_series.setdefault(exception["series_id"], []).append(exception)

    events: list[dict[str, object]] = []
    if not blocks:
        school_monday = year_start - timedelta(days=year_start.weekday())

        for item in series:
            item_exceptions = exceptions_by_series.get(item["id"], [])
            source_dates = {date_key}
            source_dates.update(
                str(exception["occurrence_date"])
                for exception in item_exceptions
                if exception.get("override_date") == date_key
            )

            for source_date in source_dates:
                source_day = Date.fromisoformat(source_date)
                source_monday = source_day - timedelta(days=source_day.weekday())
                school_week_number = (source_monday - school_monday).days // 7 + 1
                school_week_parity = "even" if school_week_number % 2 == 0 else "odd"
                if source_day < Date.fromisoformat(str(item["starts_on"])):
                    continue
                if item.get("ends_on") and source_day > Date.fromisoformat(str(item["ends_on"])):
                    continue
                recurrence = item.get("recurrence")
                if recurrence == "once":
                    if source_date != str(item["starts_on"]):
                        continue
                elif source_day.isoweekday() != int(item["day_of_week"]):
                    continue

                week_pattern = item.get("week_pattern")
                if recurrence != "once" and week_pattern in ("even", "odd") and week_pattern != school_week_parity:
                    continue

                exception = next(
                    (entry for entry in item_exceptions if entry.get("occurrence_date") == source_date),
                    None,
                )
                target_date = str((exception or {}).get("override_date") or source_date)
                if target_date != date_key or not (str(year["starts_on"]) <= target_date <= str(year["ends_on"])):
                    continue

                overrides = (exception or {}).get("overrides")
                if not isinstance(overrides, dict):
                    overrides = {}

                def value(name: str, fallback: object) -> object:
                    return overrides[name] if name in overrides else fallback

                title = value("title", item["title"])
                if title is None:
                    title = item["title"]
                subject_id = value("subject_id", item.get("subject_id"))
                teacher = value("teacher", item.get("teacher")) or ""
                room = value("room", item.get("room")) or ""
                start_time_value = value("start_time", item["start_time"])
                end_time_value = value("end_time", item["end_time"])
                start_time = str(item["start_time"] if start_time_value is None else start_time_value)[:5]
                end_time = str(item["end_time"] if end_time_value is None else end_time_value)[:5]
                events.append(
                    {
                        "id": item["id"],
                        "entry_type": item["entry_type"],
                        "title": title,
                        "subject_id": subject_id,
                        "occurrence_date": source_date,
                        "date": target_date,
                        "start_time": start_time,
                        "end_time": end_time,
                        "teacher": teacher,
                        "room": room,
                        "color_key": value("color_key", item.get("color_key")),
                        "icon_key": value("icon_key", item.get("icon_key")),
                        "cancelled": item.get("status") == "cancelled"
                        or (exception or {}).get("status") == "cancelled",
                    }
                )

    events.sort(key=lambda event: str(event["start_time"]))
    return {
        "date": date_key,
        "school_year": {
            key: year.get(key)
            for key in ("id", "name", "starts_on", "ends_on", "time_zone")
        },
        "calendar_blocks": calendar_blocks,
        "events": events,
    }


async def get_schedule(
    user_id: str,
    date: Date,
    *,
    reader: AuthenticatedPlanningReader | None = None,
) -> Mapping[str, object]:
    logger.info("planning_tool event=get_schedule_entered argument_fields=user_id,date date_count=1")
    if reader is None:
        logger.warning("planning_tool event=get_schedule_result status=unavailable reason=reader_missing")
        raise PlanningIntegrationNotConfigured(
            "L'accès serveur aux données Planning Supabase n'est pas configuré."
        )
    if reader.authenticated_user_id != user_id:
        logger.warning("planning_tool event=get_schedule_result status=denied reason=identity_mismatch")
        raise PlanningAccessDenied("Le lecteur Planning ne correspond pas à l'utilisateur authentifié.")
    try:
        result = await reader.read_schedule(date)
    except Exception as error:
        logger.warning(
            "planning_tool event=get_schedule_result status=failed error_type=%s",
            type(error).__name__,
        )
        raise

    events = result.get("events")
    event_count = len(events) if isinstance(events, list) else 0
    logger.info(
        "planning_tool event=get_schedule_result status=%s event_count=%d",
        "with_events" if event_count else "empty",
        event_count,
    )
    return result


def create_planning_tool(reader: AuthenticatedPlanningReader) -> AuthorizedTool:
    async def handle(context: AIContext, arguments: Mapping[str, object]) -> Mapping[str, object]:
        safe_fields = sorted(set(arguments).intersection({"date", "dates", "user_id"}))
        logger.info(
            "planning_tool event=arguments_received argument_fields=%s unexpected_argument_count=%d",
            ",".join(safe_fields) or "none",
            len(set(arguments).difference({"date", "dates"})),
        )
        if set(arguments) == {"date"}:
            date_values = [arguments["date"]]
        elif set(arguments) == {"dates"}:
            date_values = arguments["dates"]
            if not isinstance(date_values, list) or not 1 <= len(date_values) <= 7:
                raise ValueError("Le paramètre dates doit contenir entre 1 et 7 dates ISO.")
        else:
            raise ValueError("Seul le paramètre date ou dates est accepté.")

        if not all(isinstance(value, str) for value in date_values):
            raise ValueError("Les dates doivent être au format ISO (AAAA-MM-JJ).")
        try:
            requested_dates = [Date.fromisoformat(value) for value in date_values]
        except ValueError as error:
            raise ValueError("Les dates doivent être au format ISO (AAAA-MM-JJ).") from error

        logger.info("planning_tool event=validated_dates date_count=%d", len(requested_dates))
        schedules = [
            await get_schedule(context.user_id, requested_date, reader=reader)
            for requested_date in requested_dates
        ]
        return schedules[0] if set(arguments) == {"date"} else {"schedules": schedules}

    return AuthorizedTool(
        spec=AIToolSpec(
            name="get_schedule",
            description=(
                "Lire le Planning de l'utilisateur authentifié. Utilise date pour un jour, "
                "ou dates pour plusieurs jours (maximum 7). Les dates doivent être ISO. "
                "Pour les dates relatives, utilise la date du jour fournie dans le contexte."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "date": {"type": "string", "format": "date"},
                    "dates": {
                        "type": "array",
                        "items": {"type": "string", "format": "date"},
                        "minItems": 1,
                        "maxItems": 7,
                    },
                },
                "anyOf": [{"required": ["date"]}, {"required": ["dates"]}],
                "additionalProperties": False,
            },
        ),
        handler=handle,
    )