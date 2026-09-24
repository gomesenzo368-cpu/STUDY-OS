from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class SubjectBase(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    color: str = "#1f7a8c"
    icon: str = "📘"


class SubjectCreate(SubjectBase):
    pass


class SubjectUpdate(SubjectBase):
    pass


class SubjectRead(SubjectBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    created_at: datetime
    updated_at: datetime


class ThemeBase(BaseModel):
    subject_id: int = Field(gt=0)
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    order: int = 0


class ThemeCreate(ThemeBase):
    pass


class ThemeUpdate(ThemeBase):
    pass


class ThemeRead(ThemeBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    subject_name: str | None = None
    created_at: datetime
    updated_at: datetime


class ChapterBase(BaseModel):
    theme_id: int = Field(gt=0)
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    order: int = 0


class ChapterCreate(ChapterBase):
    pass


class ChapterUpdate(ChapterBase):
    pass


class ChapterRead(ChapterBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    theme_name: str | None = None
    subject_name: str | None = None
    created_at: datetime
    updated_at: datetime


class CourseBase(BaseModel):
    chapter_id: int = Field(gt=0)
    title: str = Field(min_length=1, max_length=180)
    content: str = ""
    original_content: str = ""
    source_type: str = "manual"
    original_filename: str | None = None
    favorite: bool = False
    order: int = 0


class CourseCreate(CourseBase):
    pass


class CourseUpdate(CourseBase):
    pass


class CourseRead(CourseBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    chapter_name: str | None = None
    theme_name: str | None = None
    subject_name: str | None = None
    created_at: datetime
    updated_at: datetime
