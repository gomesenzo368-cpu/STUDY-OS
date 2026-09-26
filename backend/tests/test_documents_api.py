import asyncio
from io import BytesIO
import json
import unittest
import uuid

import httpx
from fastapi import FastAPI, UploadFile
from fastapi.testclient import TestClient
from starlette.datastructures import Headers
from starlette.responses import Response

from app.auth import AuthenticatedUser
from app.documents_api import SupabaseCourseDocumentService, get_document_service, router, upload_course_documents
from app.main import app as production_app

OWNER_ID = "00000000-0000-0000-0000-000000000001"
OTHER_USER_ID = "00000000-0000-0000-0000-000000000002"


class FakeSupabase:
    def __init__(self) -> None:
        self.documents: dict[str, dict[str, object]] = {}
        self.objects: dict[str, bytes] = {}
        self.storage_uploads = 0
        self.fail_second_storage_upload = False
        self.fail_document_reads = False
        self.fail_signed_previews = False

    def respond(self, request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization") != "Bearer verified-access-token":
            return httpx.Response(401)
        if request.headers.get("apikey") != "public-key":
            return httpx.Response(401)

        path = request.url.path
        if path == "/rest/v1/courses":
            course_id = request.url.params.get("id", "")
            if course_id == "eq.1":
                return httpx.Response(200, json=[{"id": 1, "user_id": OWNER_ID}])
            return httpx.Response(200, json=[])

        if path == "/rest/v1/course_documents" and request.method == "GET":
            if self.fail_document_reads:
                return httpx.Response(403, json={"code": "42501", "message": "row-level security policy denied"})
            rows = list(self.documents.values())
            course_id = request.url.params.get("course_id")
            user_id = request.url.params.get("user_id")
            document_id = request.url.params.get("id")
            rows = [row for row in rows if row["user_id"] == OWNER_ID]
            if course_id:
                rows = [row for row in rows if str(row["course_id"]) == course_id.removeprefix("eq.")]
            if user_id:
                rows = [row for row in rows if str(row["user_id"]) == user_id.removeprefix("eq.")]
            if document_id:
                rows = [row for row in rows if str(row["id"]) == document_id.removeprefix("eq.")]
            return httpx.Response(200, json=rows)

        if path == "/rest/v1/course_documents" and request.method == "POST":
            row = json.loads(request.content)
            row["created_at"] = "2026-09-26T12:00:00+00:00"
            row["updated_at"] = row["created_at"]
            self.documents[str(row["id"])] = row
            return httpx.Response(201)

        if path == "/rest/v1/course_documents" and request.method == "DELETE":
            document_id = request.url.params.get("id", "").removeprefix("eq.")
            row = self.documents.get(document_id)
            if row and row["user_id"] == OWNER_ID:
                self.documents.pop(document_id)
            return httpx.Response(204)

        if path.startswith("/storage/v1/object/sign/"):
            if self.fail_signed_previews:
                return httpx.Response(403, json={"message": "signed URL denied by storage policy"})
            return httpx.Response(200, json={"signedURL": "/object/sign/course-originals/test?token=signed"})

        if path.startswith("/storage/v1/object/course-originals/") and request.method == "POST":
            self.storage_uploads += 1
            if self.fail_second_storage_upload and self.storage_uploads == 2:
                return httpx.Response(502)
            object_path = path.split("/storage/v1/object/course-originals/", 1)[1]
            self.objects[object_path] = request.content
            return httpx.Response(200, json={"Key": object_path})

        if path == "/storage/v1/object/course-originals" and request.method == "DELETE":
            prefixes = json.loads(request.content).get("prefixes", [])
            for prefix in prefixes:
                self.objects.pop(prefix, None)
            return httpx.Response(200, json={"prefixes": prefixes})

        return httpx.Response(404)


class CourseDocumentApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.supabase = FakeSupabase()
        self.app = FastAPI()
        self.app.include_router(router)

        async def get_fake_service():
            async with httpx.AsyncClient(transport=httpx.MockTransport(self.supabase.respond)) as client:
                yield SupabaseCourseDocumentService(
                    AuthenticatedUser(OWNER_ID, "verified-access-token"),
                    "https://project.supabase.co",
                    "public-key",
                    client,
                )

        self.app.dependency_overrides[get_document_service] = get_fake_service
        self.client = TestClient(self.app)

    def tearDown(self) -> None:
        self.client.close()
        self.app.dependency_overrides.clear()

    def test_production_app_mounts_document_routes_with_expected_methods(self) -> None:
        mounted = {
            (method, route.path)
            for route in production_app.routes
            if hasattr(route, "methods")
            for method in route.methods
        }
        expected = {
            ("GET", "/api/courses/{course_id}/documents"),
            ("POST", "/api/courses/{course_id}/documents"),
            ("DELETE", "/api/courses/{course_id}/documents"),
            ("DELETE", "/api/courses/{course_id}/documents/{document_id}"),
        }
        self.assertTrue(expected.issubset(mounted), expected - mounted)

    def test_get_missing_owned_course_is_course_404_not_route_404(self) -> None:
        response = self.client.get("/api/courses/99/documents")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], "Cours introuvable.")

    def test_uploads_multiple_original_files_and_lists_them_in_order(self) -> None:
        image = b"\xff\xd8\xfforiginal-image"
        pdf = b"%PDF-1.7\noriginal-pdf"
        response = self.client.post(
            "/api/courses/1/documents",
            files=[
                ("files", ("page.jpg", image, "image/jpeg")),
                ("files", ("notes.pdf", pdf, "application/pdf")),
            ],
        )

        self.assertEqual(response.status_code, 201, response.text)
        documents = response.json()
        self.assertEqual([document["position"] for document in documents], [0, 1])
        self.assertEqual([document["status"] for document in documents], ["uploaded", "uploaded"])
        self.assertEqual({value for value in self.supabase.objects.values()}, {image, pdf})
        self.assertEqual(len(self.supabase.documents), 2)

    def test_imports_documents_into_an_existing_owned_course(self) -> None:
        response = self.client.post(
            "/api/courses/1/documents",
            files=[("files", ("existing-course.jpg", b"\xff\xd8\xfforiginal", "image/jpeg"))],
        )

        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()[0]["course_id"], 1)
        self.assertEqual(len(self.supabase.documents), 1)

    def test_upload_rolls_back_metadata_and_objects_when_a_later_file_fails(self) -> None:
        self.supabase.fail_second_storage_upload = True
        response = self.client.post(
            "/api/courses/1/documents",
            files=[
                ("files", ("page-1.jpg", b"\xff\xd8\xffone", "image/jpeg")),
                ("files", ("page-2.jpg", b"\xff\xd8\xfftwo", "image/jpeg")),
            ],
        )

        self.assertEqual(response.status_code, 502, response.text)
        self.assertIn("Supabase Storage POST a répondu HTTP 502", response.json()["detail"])
        self.assertEqual(self.supabase.documents, {})
        self.assertEqual(self.supabase.objects, {})

    def test_lists_private_image_preview_and_deletes_the_original(self) -> None:
        uploaded = self.client.post(
            "/api/courses/1/documents",
            files=[("files", ("page.jpg", b"\xff\xd8\xfforiginal", "image/jpeg"))],
        )
        self.assertEqual(uploaded.status_code, 201, uploaded.text)
        document = uploaded.json()[0]

        listed = self.client.get("/api/courses/1/documents")
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertIn("/storage/v1/object/sign/course-originals/", listed.json()[0]["preview_url"])

        deleted = self.client.delete(f"/api/courses/1/documents/{document['id']}")
        self.assertEqual(deleted.status_code, 204)
        self.assertEqual(self.supabase.documents, {})
        self.assertEqual(self.supabase.objects, {})

    def test_preview_permission_error_is_visible_without_hiding_the_document(self) -> None:
        uploaded = self.client.post(
            "/api/courses/1/documents",
            files=[("files", ("page.jpg", b"\xff\xd8\xfforiginal", "image/jpeg"))],
        )
        self.assertEqual(uploaded.status_code, 201, uploaded.text)
        self.supabase.fail_signed_previews = True

        listed = self.client.get("/api/courses/1/documents")

        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(len(listed.json()), 1)
        self.assertIn("Supabase Storage POST a répondu HTTP 403", listed.json()[0]["preview_error"])

    def test_bulk_delete_removes_all_course_objects(self) -> None:
        uploaded = self.client.post(
            "/api/courses/1/documents",
            files=[
                ("files", ("page-1.jpg", b"\xff\xd8\xffone", "image/jpeg")),
                ("files", ("page-2.jpg", b"\xff\xd8\xfftwo", "image/jpeg")),
            ],
        )
        self.assertEqual(uploaded.status_code, 201, uploaded.text)

        deleted = self.client.delete("/api/courses/1/documents")

        self.assertEqual(deleted.status_code, 204)
        self.assertEqual(self.supabase.documents, {})
        self.assertEqual(self.supabase.objects, {})

    def test_course_ownership_is_checked_before_upload(self) -> None:
        response = self.client.post(
            "/api/courses/99/documents",
            files=[("files", ("page.jpg", b"\xff\xd8\xffimage", "image/jpeg"))],
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.supabase.documents, {})
        self.assertEqual(self.supabase.objects, {})

    def test_document_routes_require_a_verified_session(self) -> None:
        self.app.dependency_overrides.pop(get_document_service)

        response = self.client.get("/api/courses/1/documents")

        self.assertEqual(response.status_code, 401)

    def test_list_error_exposes_exact_supabase_status_and_body(self) -> None:
        self.supabase.fail_document_reads = True

        response = self.client.get("/api/courses/1/documents")

        self.assertEqual(response.status_code, 403)
        self.assertIn("Supabase PostgREST GET a répondu HTTP 403", response.json()["detail"])
        self.assertIn("row-level security policy denied", response.json()["detail"])

    def test_disconnect_during_upload_removes_only_the_active_document(self) -> None:
        class DisconnectAfterMetadata:
            checks = 0

            async def is_disconnected(self) -> bool:
                self.checks += 1
                return self.checks == 2

        async def perform_upload() -> Response:
            async with httpx.AsyncClient(transport=httpx.MockTransport(self.supabase.respond)) as client:
                service = SupabaseCourseDocumentService(
                    AuthenticatedUser(OWNER_ID, "verified-access-token"),
                    "https://project.supabase.co",
                    "public-key",
                    client,
                )
                upload = UploadFile(
                    filename="page.jpg",
                    file=BytesIO(b"\xff\xd8\xfforiginal"),
                    headers=Headers({"content-type": "image/jpeg"}),
                )
                return await upload_course_documents(
                    course_id=1,
                    files=[upload],
                    request=DisconnectAfterMetadata(),
                    service=service,
                )

        response = asyncio.run(perform_upload())

        self.assertEqual(response.status_code, 499)
        self.assertEqual(self.supabase.documents, {})
        self.assertEqual(self.supabase.objects, {})

    def test_mime_extension_mismatch_is_rejected(self) -> None:
        response = self.client.post(
            "/api/courses/1/documents",
            files=[("files", ("notes.pdf", b"%PDF-1.7", "image/jpeg"))],
        )

        self.assertEqual(response.status_code, 415)
        self.assertEqual(self.supabase.documents, {})

    def test_cannot_delete_another_users_document(self) -> None:
        document_id = uuid.uuid4()
        storage_path = f"other-user/1/{document_id}/original.pdf"
        self.supabase.documents[str(document_id)] = {
            "id": str(document_id),
            "user_id": OTHER_USER_ID,
            "course_id": 1,
            "storage_path": storage_path,
        }
        self.supabase.objects[storage_path] = b"%PDF-source"

        response = self.client.delete(f"/api/courses/1/documents/{document_id}")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.supabase.objects[storage_path], b"%PDF-source")

    def test_cannot_read_another_users_document(self) -> None:
        document_id = uuid.uuid4()
        storage_path = f"{OTHER_USER_ID}/1/{document_id}/original.txt"
        self.supabase.documents[str(document_id)] = {
            "id": str(document_id),
            "user_id": OTHER_USER_ID,
            "course_id": 1,
            "original_filename": "private.txt",
            "storage_path": storage_path,
            "mime_type": "text/plain",
            "file_size": 4,
            "file_hash": "0" * 64,
            "document_type": "text",
            "position": 0,
            "status": "uploaded",
            "created_at": "2026-09-26T12:00:00+00:00",
            "updated_at": "2026-09-26T12:00:00+00:00",
        }
        self.supabase.objects[storage_path] = b"secret"

        response = self.client.get("/api/courses/1/documents")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])
        self.assertEqual(self.supabase.objects[storage_path], b"secret")