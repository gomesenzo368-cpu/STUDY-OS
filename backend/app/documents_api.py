import base64
import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass
from hashlib import sha256
from io import BytesIO
import json
import logging
from pathlib import PurePath
import uuid
import zipfile
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict

from .auth import AuthenticatedUser, get_authenticated_user, local_env_value

router = APIRouter(prefix="/api/courses", tags=["course documents"])
logger = logging.getLogger(__name__)

BUCKET = "course-originals"
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_BATCH_BYTES = 50 * 1024 * 1024
MAX_FILES_PER_UPLOAD = 10
SIGNED_URL_SECONDS = 600
DOCUMENT_COLUMNS = "id,user_id,course_id,original_filename,storage_path,mime_type,file_size,file_hash,document_type,position,status,created_at,updated_at"

FILE_TYPES = {
    ".jpg": ("image/jpeg", "image"),
    ".jpeg": ("image/jpeg", "image"),
    ".png": ("image/png", "image"),
    ".webp": ("image/webp", "image"),
    ".pdf": ("application/pdf", "pdf"),
    ".txt": ("text/plain", "text"),
    ".docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "word"),
}


class DocumentServiceError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


class UploadDisconnected(Exception):
    pass


class CourseDocumentRead(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: uuid.UUID
    user_id: uuid.UUID
    course_id: int
    original_filename: str
    storage_path: str
    mime_type: str
    file_size: int
    file_hash: str
    document_type: str
    position: int
    status: str
    created_at: str
    updated_at: str
    preview_url: str | None = None
    preview_error: str | None = None


def _is_service_role_key(key: str) -> bool:
    if key.startswith("sb_secret_"):
        return True
    parts = key.split(".")
    if len(parts) != 3:
        return False
    try:
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
    except (ValueError, json.JSONDecodeError):
        return False
    return isinstance(claims, dict) and claims.get("role") == "service_role"


@dataclass
class SupabaseCourseDocumentService:
    user: AuthenticatedUser
    supabase_url: str
    publishable_key: str
    client: httpx.AsyncClient

    def __post_init__(self) -> None:
        if not self.user.user_id or not self.user.access_token or not self.supabase_url:
            raise DocumentServiceError(503, "Configuration Supabase documentaire incomplète.")
        if not self.publishable_key or _is_service_role_key(self.publishable_key):
            raise DocumentServiceError(503, "Une clé publique Supabase est requise pour respecter RLS.")
        self.supabase_url = self.supabase_url.rstrip("/")

    @property
    def headers(self) -> dict[str, str]:
        return {
            "apikey": self.publishable_key,
            "Authorization": f"Bearer {self.user.access_token}",
        }

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        body: object | None = None,
        content: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> object:
        try:
            response = await self.client.request(
                method,
                f"{self.supabase_url}{path}",
                params=params,
                json=body,
                content=content,
                headers={**self.headers, **(headers or {})},
            )
        except httpx.HTTPError as error:
            raise DocumentServiceError(503, "Supabase documentaire est indisponible.") from error
        if not response.is_success:
            response_detail = response.text.strip()[:500]
            operation = "Storage" if "/storage/" in path else "PostgREST"
            logger.warning(
                "course_documents event=supabase_error operation=%s method=%s status=%d response=%s",
                operation,
                method,
                response.status_code,
                response_detail or "<empty>",
            )
            detail = f"Supabase {operation} {method} a répondu HTTP {response.status_code}"
            if response_detail:
                detail = f"{detail} : {response_detail}"
            raise DocumentServiceError(response.status_code, detail)
        operation = "Storage" if "/storage/" in path else "PostgREST"
        logger.info(
            "course_documents event=supabase_response operation=%s method=%s status=%d",
            operation,
            method,
            response.status_code,
        )
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError as error:
            raise DocumentServiceError(503, "Réponse Supabase documentaire invalide.") from error

    async def ensure_course(self, course_id: int) -> None:
        rows = await self.request(
            "GET",
            "/rest/v1/courses",
            params={"id": f"eq.{course_id}", "select": "id,user_id", "limit": "1"},
        )
        if not isinstance(rows, list) or not rows:
            raise DocumentServiceError(404, "Cours introuvable.")
        if rows[0].get("user_id") != self.user.user_id:
            raise DocumentServiceError(403, "Ce cours ne vous appartient pas.")

    async def rows(self, course_id: int) -> list[dict[str, object]]:
        rows = await self.request(
            "GET",
            "/rest/v1/course_documents",
            params={
                "course_id": f"eq.{course_id}",
                "user_id": f"eq.{self.user.user_id}",
                "select": DOCUMENT_COLUMNS,
                "order": "position.asc,created_at.asc",
            },
        )
        if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
            raise DocumentServiceError(503, "Réponse de documents invalide.")
        return rows

    async def create_row(self, row: dict[str, object]) -> None:
        await self.request(
            "POST",
            "/rest/v1/course_documents",
            body=row,
            headers={"Prefer": "return=minimal"},
        )

    async def upload_object(self, storage_path: str, payload: bytes, mime_type: str) -> None:
        encoded_path = quote(storage_path, safe="/")
        await self.request(
            "POST",
            f"/storage/v1/object/{BUCKET}/{encoded_path}",
            content=payload,
            headers={"Content-Type": mime_type, "x-upsert": "false"},
        )

    async def remove_object(self, storage_path: str) -> None:
        try:
            await self.request(
                "DELETE",
                f"/storage/v1/object/{BUCKET}",
                body={"prefixes": [storage_path]},
            )
        except DocumentServiceError as error:
            if error.status_code != 404:
                raise

    async def remove_row(self, document_id: uuid.UUID, course_id: int) -> None:
        await self.request(
            "DELETE",
            "/rest/v1/course_documents",
            params={"id": f"eq.{document_id}", "course_id": f"eq.{course_id}"},
            headers={"Prefer": "return=minimal"},
        )

    async def mark_failed(self, document_id: uuid.UUID, course_id: int) -> None:
        await self.request(
            "PATCH",
            "/rest/v1/course_documents",
            params={
                "id": f"eq.{document_id}",
                "course_id": f"eq.{course_id}",
                "user_id": f"eq.{self.user.user_id}",
            },
            body={"status": "failed"},
            headers={"Prefer": "return=minimal"},
        )

    async def signed_preview_url(self, storage_path: str) -> str:
        encoded_path = quote(storage_path, safe="/")
        result = await self.request(
            "POST",
            f"/storage/v1/object/sign/{BUCKET}/{encoded_path}",
            body={"expiresIn": SIGNED_URL_SECONDS},
        )
        if not isinstance(result, dict) or not isinstance(result.get("signedURL"), str):
            raise DocumentServiceError(503, "URL de prévisualisation indisponible.")
        signed_path = result["signedURL"]
        if signed_path.startswith("http://") or signed_path.startswith("https://"):
            return signed_path
        if signed_path.startswith("/storage/v1/"):
            return f"{self.supabase_url}{signed_path}"
        return f"{self.supabase_url}/storage/v1{signed_path}"

    async def delete_document(self, course_id: int, document_id: uuid.UUID) -> None:
        rows = await self.request(
            "GET",
            "/rest/v1/course_documents",
            params={
                "id": f"eq.{document_id}",
                "course_id": f"eq.{course_id}",
                "user_id": f"eq.{self.user.user_id}",
                "select": "id,storage_path",
                "limit": "1",
            },
        )
        if not isinstance(rows, list) or not rows:
            raise DocumentServiceError(404, "Document introuvable.")
        storage_path = rows[0].get("storage_path")
        if not isinstance(storage_path, str):
            raise DocumentServiceError(503, "Chemin de stockage invalide.")
        await self.remove_object(storage_path)
        await self.remove_row(document_id, course_id)

    async def delete_course_documents(self, course_id: int) -> None:
        for row in await self.rows(course_id):
            try:
                document_id = uuid.UUID(str(row["id"]))
            except (KeyError, ValueError) as error:
                raise DocumentServiceError(503, "Identifiant documentaire invalide.") from error
            await self.delete_document(course_id, document_id)


async def get_document_service(
    user: AuthenticatedUser = Depends(get_authenticated_user),
) -> AsyncIterator[SupabaseCourseDocumentService]:
    supabase_url = local_env_value("SUPABASE_URL") or local_env_value("VITE_SUPABASE_URL")
    publishable_key = local_env_value("SUPABASE_PUBLISHABLE_KEY") or local_env_value("VITE_SUPABASE_PUBLISHABLE_KEY")
    if not supabase_url or not publishable_key or _is_service_role_key(publishable_key):
        raise HTTPException(status_code=503, detail="Configuration Supabase documentaire invalide.")
    async with httpx.AsyncClient(timeout=60) as client:
        yield SupabaseCourseDocumentService(user, supabase_url, publishable_key, client)


def _validate_payload(file: UploadFile, payload: bytes) -> tuple[str, str, str]:
    filename = (file.filename or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not filename or "\x00" in filename:
        raise DocumentServiceError(422, "Nom de fichier invalide.")
    extension = PurePath(filename).suffix.lower()
    expected = FILE_TYPES.get(extension)
    if expected is None:
        raise DocumentServiceError(415, "Formats acceptés : JPG, PNG, WebP, PDF, TXT et DOCX.")
    expected_mime, document_type = expected
    received_mime = (file.content_type or "").split(";", 1)[0].strip().lower()
    if received_mime != expected_mime:
        raise DocumentServiceError(415, "Le type MIME ne correspond pas à l’extension du fichier.")
    if not payload:
        raise DocumentServiceError(422, "Le fichier est vide.")
    if extension in (".jpg", ".jpeg") and not payload.startswith(b"\xff\xd8\xff"):
        raise DocumentServiceError(415, "Le contenu du fichier JPEG est invalide.")
    if extension == ".png" and not payload.startswith(b"\x89PNG\r\n\x1a\n"):
        raise DocumentServiceError(415, "Le contenu du fichier PNG est invalide.")
    if extension == ".webp" and not (payload.startswith(b"RIFF") and payload[8:12] == b"WEBP"):
        raise DocumentServiceError(415, "Le contenu du fichier WebP est invalide.")
    if extension == ".pdf" and not payload.startswith(b"%PDF-"):
        raise DocumentServiceError(415, "Le contenu du fichier PDF est invalide.")
    if extension == ".txt":
        try:
            payload.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise DocumentServiceError(415, "Le fichier TXT doit être encodé en UTF-8.") from error
    if extension == ".docx":
        try:
            with zipfile.ZipFile(BytesIO(payload)) as document:
                names = set(document.namelist())
        except (zipfile.BadZipFile, OSError) as error:
            raise DocumentServiceError(415, "Le contenu DOCX est invalide.") from error
        if "[Content_Types].xml" not in names or "word/document.xml" not in names:
            raise DocumentServiceError(415, "Le contenu DOCX est invalide.")
    return filename, extension, document_type


async def _rollback_uploads(
    service: SupabaseCourseDocumentService,
    course_id: int,
    created: list[tuple[uuid.UUID, str]],
) -> None:
    for document_id, storage_path in reversed(created):
        try:
            await service.remove_object(storage_path)
        except DocumentServiceError:
            try:
                await service.mark_failed(document_id, course_id)
            except DocumentServiceError:
                logger.error("course_documents event=rollback_status_failed document_id=%s", document_id)
            continue
        try:
            await service.remove_row(document_id, course_id)
        except DocumentServiceError:
            logger.error("course_documents event=rollback_failed document_id=%s", document_id)


@router.post("/{course_id}/documents", response_model=list[CourseDocumentRead], status_code=status.HTTP_201_CREATED)
async def upload_course_documents(
    course_id: int,
    request: Request,
    files: list[UploadFile] = File(...),
    service: SupabaseCourseDocumentService = Depends(get_document_service),
) -> list[CourseDocumentRead] | Response:
    if not files or len(files) > MAX_FILES_PER_UPLOAD:
        raise HTTPException(status_code=413, detail=f"Sélectionne entre 1 et {MAX_FILES_PER_UPLOAD} fichiers.")
    payloads: list[tuple[bytes, str, str, str]] = []
    total_size = 0
    for file in files:
        payload = await file.read(MAX_FILE_BYTES + 1)
        if len(payload) > MAX_FILE_BYTES:
            raise HTTPException(status_code=413, detail="Un fichier ne doit pas dépasser 20 Mo.")
        total_size += len(payload)
        if total_size > MAX_BATCH_BYTES:
            raise HTTPException(status_code=413, detail="L’import groupé ne doit pas dépasser 50 Mo.")
        try:
            filename, extension, document_type = _validate_payload(file, payload)
        except DocumentServiceError as error:
            raise HTTPException(status_code=error.status_code, detail=error.detail) from error
        payloads.append((payload, filename, extension, document_type))

    try:
        await service.ensure_course(course_id)
        existing = await service.rows(course_id)
    except DocumentServiceError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from error
    next_position = max((int(row.get("position", -1)) for row in existing), default=-1) + 1
    logger.info(
        "course_documents event=upload_started course_id=%d file_count=%d total_bytes=%d",
        course_id,
        len(payloads),
        total_size,
    )
    created: list[tuple[uuid.UUID, str]] = []
    try:
        for offset, (payload, filename, extension, document_type) in enumerate(payloads):
            if await request.is_disconnected():
                raise UploadDisconnected
            document_id = uuid.uuid4()
            storage_path = f"{service.user.user_id}/{course_id}/{document_id}/original{extension}"
            row: dict[str, object] = {
                "id": str(document_id),
                "user_id": service.user.user_id,
                "course_id": course_id,
                "original_filename": filename,
                "storage_path": storage_path,
                "mime_type": FILE_TYPES[extension][0],
                "file_size": len(payload),
                "file_hash": sha256(payload).hexdigest(),
                "document_type": document_type,
                "position": next_position + offset,
                "status": "uploaded",
            }
            created.append((document_id, storage_path))
            await service.create_row(row)
            logger.info("course_documents event=metadata_saved course_id=%d document_type=%s", course_id, document_type)
            if await request.is_disconnected():
                raise UploadDisconnected
            await service.upload_object(storage_path, payload, str(row["mime_type"]))
            logger.info("course_documents event=original_stored course_id=%d file_size=%d", course_id, len(payload))
            if await request.is_disconnected():
                raise UploadDisconnected
        rows = await service.rows(course_id)
        if await request.is_disconnected():
            raise UploadDisconnected
        logger.info("course_documents event=upload_response_ready course_id=%d document_count=%d", course_id, len(created))
    except UploadDisconnected:
        logger.info("course_documents event=upload_cancelled course_id=%d document_count=%d", course_id, len(created))
        await _rollback_uploads(service, course_id, created)
        return Response(status_code=499)
    except asyncio.CancelledError:
        logger.info("course_documents event=upload_cancelled course_id=%d document_count=%d", course_id, len(created))
        await asyncio.shield(_rollback_uploads(service, course_id, created))
        raise
    except Exception as error:
        await _rollback_uploads(service, course_id, created)
        if isinstance(error, DocumentServiceError):
            raise HTTPException(status_code=error.status_code, detail=error.detail) from error
        logger.error("course_documents event=upload_failed error_type=%s", type(error).__name__)
        raise HTTPException(status_code=503, detail="Import documentaire interrompu.") from error

    created_ids = {str(document_id) for document_id, _ in created}
    return [CourseDocumentRead(**row) for row in rows if row.get("id") in created_ids]


@router.get("/{course_id}/documents", response_model=list[CourseDocumentRead])
async def list_course_documents(
    course_id: int,
    service: SupabaseCourseDocumentService = Depends(get_document_service),
) -> list[CourseDocumentRead]:
    try:
        await service.ensure_course(course_id)
        rows = await service.rows(course_id)
    except DocumentServiceError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from error
    logger.info("course_documents event=list_loaded course_id=%d document_count=%d", course_id, len(rows))
    documents: list[CourseDocumentRead] = []
    for row in rows:
        if row.get("document_type") == "image":
            try:
                row["preview_url"] = await service.signed_preview_url(str(row["storage_path"]))
            except DocumentServiceError as error:
                row["preview_error"] = error.detail
                logger.warning(
                    "course_documents event=preview_unavailable document_id=%s status=%d detail=%s",
                    row.get("id"),
                    error.status_code,
                    error.detail,
                )
        documents.append(CourseDocumentRead(**row))
    return documents


@router.delete("/{course_id}/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_course_document(
    course_id: int,
    document_id: uuid.UUID,
    service: SupabaseCourseDocumentService = Depends(get_document_service),
) -> None:
    try:
        await service.ensure_course(course_id)
        await service.delete_document(course_id, document_id)
    except DocumentServiceError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from error


@router.delete("/{course_id}/documents", status_code=status.HTTP_204_NO_CONTENT)
async def delete_all_course_documents(
    course_id: int,
    service: SupabaseCourseDocumentService = Depends(get_document_service),
) -> None:
    try:
        await service.ensure_course(course_id)
        await service.delete_course_documents(course_id)
    except DocumentServiceError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from error