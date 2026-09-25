-- Additive compatibility migration: keep theme_id and the themes table untouched.
alter table public.chapters
  add column if not exists subject_id bigint references public.subjects(id) on delete cascade;

alter table public.chapters
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

alter table public.courses
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- Preserve existing content by deriving the new direct subject relation once.
update public.chapters as chapter
set subject_id = theme.subject_id
from public.themes as theme
where chapter.subject_id is null
  and chapter.theme_id = theme.id;

update public.chapters as chapter
set user_id = subject.user_id
from public.subjects as subject
where chapter.user_id is null
  and chapter.subject_id = subject.id;

update public.courses as course
set user_id = chapter.user_id
from public.chapters as chapter
where course.user_id is null
  and course.chapter_id = chapter.id;

alter table public.chapters enable row level security;
alter table public.courses enable row level security;

drop policy if exists "chapters_select_own" on public.chapters;
drop policy if exists "chapters_insert_own" on public.chapters;
drop policy if exists "chapters_update_own" on public.chapters;
drop policy if exists "chapters_delete_own" on public.chapters;
create policy "chapters_select_own" on public.chapters for select using (auth.uid() = user_id);
create policy "chapters_insert_own" on public.chapters for insert with check (auth.uid() = user_id);
create policy "chapters_update_own" on public.chapters for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "chapters_delete_own" on public.chapters for delete using (auth.uid() = user_id);

drop policy if exists "courses_select_own" on public.courses;
drop policy if exists "courses_insert_own" on public.courses;
drop policy if exists "courses_update_own" on public.courses;
drop policy if exists "courses_delete_own" on public.courses;
create policy "courses_select_own" on public.courses for select using (auth.uid() = user_id);
create policy "courses_insert_own" on public.courses for insert with check (auth.uid() = user_id);
create policy "courses_update_own" on public.courses for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "courses_delete_own" on public.courses for delete using (auth.uid() = user_id);
