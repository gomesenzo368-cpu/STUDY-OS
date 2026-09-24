from collections.abc import Generator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

DATABASE_URL = "sqlite:///./study_os.db"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def migrate_course_columns() -> None:
    """Additive migration for the local SQLite database used by the first release."""
    columns = {column["name"] for column in inspect(engine).get_columns("courses")}
    with engine.begin() as connection:
        if "favorite" not in columns:
            connection.execute(text("ALTER TABLE courses ADD COLUMN favorite BOOLEAN NOT NULL DEFAULT 0"))
        if "original_filename" not in columns:
            connection.execute(text("ALTER TABLE courses ADD COLUMN original_filename VARCHAR(255)"))


def migrate_user_columns() -> None:
    """Add nullable ownership columns without deleting existing local data."""
    tables = ("subjects", "themes", "chapters", "courses")
    with engine.begin() as connection:
        for table in tables:
            columns = {column["name"] for column in inspect(engine).get_columns(table)}
            if "user_id" not in columns:
                connection.execute(text(f"ALTER TABLE {table} ADD COLUMN user_id VARCHAR(36)"))
