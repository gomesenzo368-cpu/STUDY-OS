-- Tighten ownership checks for the direct hierarchy without changing data.
drop policy if exists "chapters_select_own" on public.chapters;
drop policy if exists "chapters_insert_own" on public.chapters;
drop policy if exists "chapters_update_own" on public.chapters;
drop policy if exists "chapters_delete_own" on public.chapters;
create policy "chapters_select_own" on public.chapters for select
  using (
    auth.uid() = chapters.user_id
    and exists (
      select 1
      from public.subjects as subject
      where subject.id = chapters.subject_id
        and subject.user_id = auth.uid()
    )
  );
create policy "chapters_insert_own" on public.chapters for insert
  with check (
    auth.uid() = chapters.user_id
    and exists (
      select 1
      from public.subjects as subject
      where subject.id = chapters.subject_id
        and subject.user_id = auth.uid()
    )
  );
create policy "chapters_update_own" on public.chapters for update
  using (
    auth.uid() = chapters.user_id
    and exists (
      select 1
      from public.subjects as subject
      where subject.id = chapters.subject_id
        and subject.user_id = auth.uid()
    )
  )
  with check (
    auth.uid() = chapters.user_id
    and exists (
      select 1
      from public.subjects as subject
      where subject.id = chapters.subject_id
        and subject.user_id = auth.uid()
    )
  );
create policy "chapters_delete_own" on public.chapters for delete
  using (
    auth.uid() = chapters.user_id
    and exists (
      select 1
      from public.subjects as subject
      where subject.id = chapters.subject_id
        and subject.user_id = auth.uid()
    )
  );

drop policy if exists "course_folders_insert_own" on public.course_folders;
drop policy if exists "course_folders_update_own" on public.course_folders;
drop policy if exists "course_folders_select_own" on public.course_folders;
drop policy if exists "course_folders_delete_own" on public.course_folders;
create policy "course_folders_select_own" on public.course_folders for select
  using (
    auth.uid() = course_folders.user_id
    and exists (
      select 1
      from public.chapters as chapter
      where chapter.id = course_folders.chapter_id
        and chapter.user_id = auth.uid()
    )
  );
create policy "course_folders_insert_own" on public.course_folders for insert
  with check (
    auth.uid() = course_folders.user_id
    and exists (
      select 1
      from public.chapters as chapter
      where chapter.id = course_folders.chapter_id
        and chapter.user_id = auth.uid()
    )
  );
create policy "course_folders_update_own" on public.course_folders for update
  using (
    auth.uid() = course_folders.user_id
    and exists (
      select 1
      from public.chapters as chapter
      where chapter.id = course_folders.chapter_id
        and chapter.user_id = auth.uid()
    )
  )
  with check (
    auth.uid() = course_folders.user_id
    and exists (
      select 1
      from public.chapters as chapter
      where chapter.id = course_folders.chapter_id
        and chapter.user_id = auth.uid()
    )
  );
create policy "course_folders_delete_own" on public.course_folders for delete
  using (
    auth.uid() = course_folders.user_id
    and exists (
      select 1
      from public.chapters as chapter
      where chapter.id = course_folders.chapter_id
        and chapter.user_id = auth.uid()
    )
  );

drop policy if exists "courses_select_own" on public.courses;
drop policy if exists "courses_insert_own" on public.courses;
drop policy if exists "courses_update_own" on public.courses;
drop policy if exists "courses_delete_own" on public.courses;
create policy "courses_select_own" on public.courses for select
  using (
    auth.uid() = courses.user_id
    and exists (
      select 1
      from public.chapters as chapter
      where chapter.id = courses.chapter_id
        and chapter.user_id = auth.uid()
    )
    and (
      courses.folder_id is null
      or exists (
        select 1
        from public.course_folders as folder
        where folder.id = courses.folder_id
          and folder.user_id = auth.uid()
      )
    )
  );
create policy "courses_insert_own" on public.courses for insert
  with check (
    auth.uid() = courses.user_id
    and exists (
      select 1
      from public.chapters as chapter
      where chapter.id = courses.chapter_id
        and chapter.user_id = auth.uid()
    )
    and (
      courses.folder_id is null
      or exists (
        select 1
        from public.course_folders as folder
        where folder.id = courses.folder_id
          and folder.user_id = auth.uid()
      )
    )
  );
create policy "courses_update_own" on public.courses for update
  using (
    auth.uid() = courses.user_id
    and exists (
      select 1
      from public.chapters as chapter
      where chapter.id = courses.chapter_id
        and chapter.user_id = auth.uid()
    )
    and (
      courses.folder_id is null
      or exists (
        select 1
        from public.course_folders as folder
        where folder.id = courses.folder_id
          and folder.user_id = auth.uid()
      )
    )
  )
  with check (
    auth.uid() = courses.user_id
    and exists (
      select 1
      from public.chapters as chapter
      where chapter.id = courses.chapter_id
        and chapter.user_id = auth.uid()
    )
    and (
      courses.folder_id is null
      or exists (
        select 1
        from public.course_folders as folder
        where folder.id = courses.folder_id
          and folder.user_id = auth.uid()
      )
    )
  );
create policy "courses_delete_own" on public.courses for delete
  using (auth.uid() = courses.user_id);
