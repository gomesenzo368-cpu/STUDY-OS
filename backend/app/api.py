from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import get_db
from .auth import get_current_user_id
from .models import Chapter, Course, Subject, Theme
from .schemas import (
    ChapterCreate, ChapterRead, ChapterUpdate, CourseCreate, CourseRead, CourseUpdate,
    SubjectCreate, SubjectRead, SubjectUpdate, ThemeCreate, ThemeRead, ThemeUpdate,
)

router = APIRouter(prefix="/api")


def not_found(label: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"{label} introuvable.")


def ensure_parent(db: Session, model: Any, identifier: int, label: str, user_id: str) -> None:
    if db.scalar(select(model.id).where(model.id == identifier, (model.user_id == user_id) | model.user_id.is_(None))) is None:
        raise HTTPException(status_code=422, detail=f"{label} n'existe pas.")


def crud_routes(model: Any, read_schema: Any, create_schema: Any, update_schema: Any, path: str, label: str, parent_model: Any = None, parent_field: str | None = None) -> None:
    @router.get(path, response_model=list[read_schema])
    def list_items(db: Session = Depends(get_db), user_id: str = Depends(get_current_user_id)) -> list[Any]:
        query = select(model).where((model.user_id == user_id) | model.user_id.is_(None))
        if hasattr(model, "order"):
            query = query.order_by(model.order, model.id)
        else:
            query = query.order_by(model.id)
        items = list(db.scalars(query).all())
        for item in items:
            if isinstance(item, Theme):
                item.subject_name = item.subject.name
            elif isinstance(item, Chapter):
                item.theme_name = item.theme.name
                item.subject_name = item.theme.subject.name
            elif isinstance(item, Course):
                item.chapter_name = item.chapter.name
                item.theme_name = item.chapter.theme.name
                item.subject_name = item.chapter.theme.subject.name
        return items

    @router.post(path, response_model=read_schema, status_code=status.HTTP_201_CREATED)
    def create_item(payload: create_schema, db: Session = Depends(get_db), user_id: str = Depends(get_current_user_id)) -> Any:
        if parent_model and parent_field:
            ensure_parent(db, parent_model, getattr(payload, parent_field), {Subject: "La matière", Theme: "Le thème", Chapter: "Le chapitre"}[parent_model], user_id)
        item = model(user_id=user_id, **payload.model_dump())
        db.add(item)
        db.commit()
        db.refresh(item)
        return item

    @router.get(f"{path}/{{item_id}}", response_model=read_schema)
    def get_item(item_id: int, db: Session = Depends(get_db), user_id: str = Depends(get_current_user_id)) -> Any:
        item = db.scalar(select(model).where(model.id == item_id, (model.user_id == user_id) | model.user_id.is_(None)))
        if item is None:
            raise not_found(label)
        return item

    @router.put(f"{path}/{{item_id}}", response_model=read_schema)
    def update_item(item_id: int, payload: update_schema, db: Session = Depends(get_db), user_id: str = Depends(get_current_user_id)) -> Any:
        item = db.scalar(select(model).where(model.id == item_id, (model.user_id == user_id) | model.user_id.is_(None)))
        if item is None:
            raise not_found(label)
        if parent_model and parent_field:
            ensure_parent(db, parent_model, getattr(payload, parent_field), {Subject: "La matière", Theme: "Le thème", Chapter: "Le chapitre"}[parent_model], user_id)
        for key, value in payload.model_dump().items():
            setattr(item, key, value)
        db.commit()
        db.refresh(item)
        return item

    @router.delete(f"{path}/{{item_id}}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_item(item_id: int, db: Session = Depends(get_db), user_id: str = Depends(get_current_user_id)) -> None:
        item = db.scalar(select(model).where(model.id == item_id, (model.user_id == user_id) | model.user_id.is_(None)))
        if item is None:
            raise not_found(label)
        db.delete(item)
        db.commit()


crud_routes(Subject, SubjectRead, SubjectCreate, SubjectUpdate, "/subjects", "La matière")
crud_routes(Theme, ThemeRead, ThemeCreate, ThemeUpdate, "/themes", "Le thème", Subject, "subject_id")
crud_routes(Chapter, ChapterRead, ChapterCreate, ChapterUpdate, "/chapters", "Le chapitre", Theme, "theme_id")
@router.post("/courses/import")
async def import_course_file(file: UploadFile = File(...), _: str = Depends(get_current_user_id)) -> dict[str, str | None]:
    allowed_types = {".txt", ".pdf", ".docx"}
    filename = file.filename or ""
    suffix = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if suffix not in allowed_types:
        raise HTTPException(status_code=415, detail="Format accepté : TXT, PDF ou DOCX.")

    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Le fichier ne doit pas dépasser 10 Mo.")

    if suffix == ".txt":
        extracted = content.decode("utf-8", errors="replace")
    elif suffix == ".pdf":
        from pypdf import PdfReader
        from io import BytesIO

        extracted = "\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(content)).pages).strip()
    else:
        from docx import Document
        from io import BytesIO

        extracted = "\n".join(paragraph.text for paragraph in Document(BytesIO(content)).paragraphs).strip()

    return {"filename": filename, "content": extracted, "source_type": suffix[1:]}


crud_routes(Course, CourseRead, CourseCreate, CourseUpdate, "/courses", "Le cours", Chapter, "chapter_id")
