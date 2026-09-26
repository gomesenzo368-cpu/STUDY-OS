from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import models
from .api import router
from .ai.api import router as ai_router
from .documents_api import router as documents_router
from .revisions_api import router as revisions_router
from .database import Base, SessionLocal, engine, migrate_course_columns, migrate_user_columns
from .seed import seed_demo_data

app = FastAPI(title="STUDY OS API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router)
app.include_router(ai_router)
app.include_router(documents_router)
app.include_router(revisions_router)


@app.on_event("startup")
def startup() -> None:
    Base.metadata.create_all(bind=engine)
    migrate_course_columns()
    migrate_user_columns()
    with SessionLocal() as db:
        seed_demo_data(db)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "study-os-api"}
