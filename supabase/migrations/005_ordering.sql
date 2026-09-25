-- Additive ordering for subjects, chapters, and mixed chapter items.
-- Existing rows receive position 0..n-1 with newest records first.
alter table public.subjects
  add column if not exists position integer;

alter table public.courses
  add column if not exists position integer;

alter table public.course_folders
  add column if not exists position integer;

with ranked_subjects as (
  select id,
         row_number() over (partition by user_id order by created_at desc, id desc) - 1 as next_position
  from public.subjects
  where position is null
)
update public.subjects as subject
set position = ranked_subjects.next_position
from ranked_subjects
where subject.id = ranked_subjects.id
  and subject.position is null;

with ranked_chapters as (
  select id,
         row_number() over (partition by user_id, subject_id order by created_at desc, id desc) - 1 as next_position
  from public.chapters
  where position is null
)
update public.chapters as chapter
set position = ranked_chapters.next_position
from ranked_chapters
where chapter.id = ranked_chapters.id
  and chapter.position is null;

with chapter_items as (
  select id, chapter_id, created_at, 'course'::text as item_type
  from public.courses
  union all
  select id, chapter_id, created_at, 'folder'::text as item_type
  from public.course_folders
), ranked_items as (
  select id,
         item_type,
         row_number() over (partition by chapter_id order by created_at desc, id desc) - 1 as next_position
  from chapter_items
)
update public.courses as course
set position = ranked_items.next_position
from ranked_items
where ranked_items.item_type = 'course'
  and course.id = ranked_items.id
  and course.position is null;

with chapter_items as (
  select id, chapter_id, created_at, 'course'::text as item_type
  from public.courses
  union all
  select id, chapter_id, created_at, 'folder'::text as item_type
  from public.course_folders
), ranked_items as (
  select id,
         item_type,
         row_number() over (partition by chapter_id order by created_at desc, id desc) - 1 as next_position
  from chapter_items
)
update public.course_folders as folder
set position = ranked_items.next_position
from ranked_items
where ranked_items.item_type = 'folder'
  and folder.id = ranked_items.id
  and folder.position is null;
