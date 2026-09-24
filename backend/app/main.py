from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import models
from .api import router
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
