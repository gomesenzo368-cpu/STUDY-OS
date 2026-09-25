-- Persist the order of courses inside folders.
-- This migration does not modify chapter_items or chapter-level ordering.

alter table public.courses
  add column if not exists folder_position integer;

drop table if exists pg_temp.folder_position_assignments;

create temporary table folder_position_assignments on commit drop as
with ranked_positions as (
  select
    course.id,
    course.folder_id,
    course.folder_position,
    row_number() over (
      partition by course.folder_id, course.folder_position
      order by course.id asc
    ) as position_occurrence
  from public.courses as course
  where course.folder_id is not null
)
select
  ranked_positions.id,
  ranked_positions.folder_id,
  case
    when ranked_positions.folder_position is not null
     and ranked_positions.folder_position >= 0
     and (
       ranked_positions.folder_position is null
       or ranked_positions.position_occurrence = 1
     )
    then ranked_positions.folder_position::bigint
    else null
  end as retained_position
from ranked_positions;

-- Clear only folder positions that belong to a course. This makes the
-- deterministic repair below independent from the order of the updates.
update public.courses as course
set folder_position = null
where course.folder_id is not null;

update public.courses as course
set folder_position = assignments.retained_position::integer
from folder_position_assignments as assignments
where course.id = assignments.id
  and assignments.retained_position is not null;

do $$
begin
  if exists (
    with unassigned as (
      select
        assignments.folder_id,
        row_number() over (
          partition by assignments.folder_id
          order by course.created_at asc, course.id asc
        ) as new_position_offset,
        coalesce(
          max(assignments.retained_position) over (
            partition by assignments.folder_id
          ),
          -1
        ) as retained_max
      from folder_position_assignments as assignments
      join public.courses as course
        on course.id = assignments.id
      where assignments.retained_position is null
    )
    select 1
    from unassigned
    where retained_max + new_position_offset > 2147483647
  ) then
    raise exception 'Impossible d’initialiser les positions des cours du dossier.'
      using errcode = '22003';
  end if;
end;
$$;

with unassigned as (
  select
    assignments.id,
    (
      coalesce(
        max(assignments.retained_position) over (
          partition by assignments.folder_id
        ),
        -1
      )
      + row_number() over (
          partition by assignments.folder_id
          order by course.created_at asc, course.id asc
        )
    )::integer as next_position
  from folder_position_assignments as assignments
  join public.courses as course
    on course.id = assignments.id
  where assignments.retained_position is null
)
update public.courses as course
set folder_position = unassigned.next_position
from unassigned
where course.id = unassigned.id
  and course.folder_id is not null
  and course.folder_position is null;

-- Courses without a folder must never retain a folder position.
update public.courses as course
set folder_position = null
where course.folder_id is null
  and course.folder_position is not null;

do $$
begin
  if exists (
    select 1
    from public.courses as course
    join public.course_folders as folder
      on folder.id = course.folder_id
    where course.chapter_id <> folder.chapter_id
  ) then
    raise exception 'Un cours appartient à un dossier d’un autre chapitre.'
      using errcode = '23514';
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.courses'::regclass
      and conname = 'courses_folder_position_consistency_check'
  ) then
    alter table public.courses
      add constraint courses_folder_position_consistency_check
      check (
        (folder_id is null and folder_position is null)
        or
        (folder_id is not null and folder_position >= 0)
      );
  end if;
end;
$$;

create unique index if not exists courses_folder_position_key
  on public.courses (folder_id, folder_position)
  where folder_id is not null
    and folder_position is not null;

create index if not exists courses_folder_order_lookup
  on public.courses (folder_id, folder_position)
  where folder_id is not null;

create or replace function public.reorder_folder_courses(
  p_folder_id bigint,
  p_items jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  authenticated_user uuid := auth.uid();
  folder_chapter_id bigint;
  requested_count integer;
  current_count integer;
  max_position bigint;
  temporary_base bigint;
begin
  if authenticated_user is null then
    raise exception 'Utilisateur non authentifié.'
      using errcode = '42501';
  end if;

  if p_folder_id is null then
    raise exception 'folder_id obligatoire.'
      using errcode = '22023';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items doit être un tableau JSON.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.course_folders as folder
    where folder.id = p_folder_id
      and folder.user_id = authenticated_user
  ) then
    raise exception 'Dossier inaccessible.'
      using errcode = '42501';
  end if;

  select folder.chapter_id
  into folder_chapter_id
  from public.course_folders as folder
  where folder.id = p_folder_id
    and folder.user_id = authenticated_user;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'folder_courses:' ||
      authenticated_user::text ||
      ':' ||
      p_folder_id::text,
      0
    )
  );

  if exists (
    select 1
    from jsonb_array_elements(p_items) as element(value)
    where jsonb_typeof(element.value) <> 'object'
       or coalesce(element.value ->> 'id', '') !~ '^[1-9][0-9]*$'
  ) then
    raise exception 'Chaque élément doit contenir un id positif.'
      using errcode = '22023';
  end if;

  if exists (
    select (element.value ->> 'id')::bigint
    from jsonb_array_elements(p_items) as element(value)
    group by (element.value ->> 'id')::bigint
    having count(*) > 1
  ) then
    raise exception 'La liste contient des cours dupliqués.'
      using errcode = '22023';
  end if;

  drop table if exists pg_temp.reorder_folder_courses_request;
  drop table if exists pg_temp.reorder_folder_courses_current;

  create temporary table reorder_folder_courses_request (
    course_id bigint primary key,
    new_position integer not null unique
  ) on commit drop;

  insert into reorder_folder_courses_request (
    course_id,
    new_position
  )
  select
    (element.value ->> 'id')::bigint,
    element.ordinality::integer - 1
  from jsonb_array_elements(p_items)
    with ordinality as element(value, ordinality);

  perform 1
  from public.courses as course
  where course.folder_id = p_folder_id
    and course.user_id = authenticated_user
  for update;

  create temporary table reorder_folder_courses_current (
    course_id bigint primary key
  ) on commit drop;

  insert into reorder_folder_courses_current (course_id)
  select course.id
  from public.courses as course
  where course.folder_id = p_folder_id
    and course.user_id = authenticated_user;

  select count(*)
  into requested_count
  from reorder_folder_courses_request;

  select count(*)
  into current_count
  from reorder_folder_courses_current;

  if requested_count <> current_count then
    raise exception 'La liste reçue ne correspond pas aux cours du dossier.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from reorder_folder_courses_request as requested
    left join reorder_folder_courses_current as current_course
      on current_course.course_id = requested.course_id
    where current_course.course_id is null
  ) then
    raise exception 'La liste contient un cours absent du dossier.'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from reorder_folder_courses_current as current_course
    left join reorder_folder_courses_request as requested
      on requested.course_id = current_course.course_id
    where requested.course_id is null
  ) then
    raise exception 'La liste ne contient pas tous les cours du dossier.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from reorder_folder_courses_request as requested
    where not exists (
      select 1
      from public.courses as course
      where course.id = requested.course_id
        and course.user_id = authenticated_user
        and course.folder_id = p_folder_id
        and course.chapter_id = folder_chapter_id
    )
  ) then
    raise exception 'Un cours ne correspond pas à ce dossier ou à cet utilisateur.'
      using errcode = '42501';
  end if;

  if current_count > 0 then
    select coalesce(max(course.folder_position::bigint), -1)
    into max_position
    from public.courses as course
    where course.folder_id = p_folder_id
      and course.user_id = authenticated_user;

    temporary_base := max_position + current_count + 1;

    if temporary_base + current_count - 1 > 2147483647 then
      raise exception 'Impossible de créer une plage temporaire de positions.'
        using errcode = '22003';
    end if;

    with temporary_positions as (
      select
        course.id,
        row_number() over (order by course.id)::bigint - 1 as position_offset
      from public.courses as course
      where course.folder_id = p_folder_id
        and course.user_id = authenticated_user
    )
    update public.courses as course
    set folder_position = (
      temporary_base + temporary_positions.position_offset
    )::integer
    from temporary_positions
    where course.id = temporary_positions.id;
  end if;

  update public.courses as course
  set folder_position = requested.new_position
  from reorder_folder_courses_request as requested
  where course.id = requested.course_id
    and course.folder_id = p_folder_id
    and course.user_id = authenticated_user;

  return true;
end;
$$;

revoke all on function public.reorder_folder_courses(bigint, jsonb) from public;
grant execute on function public.reorder_folder_courses(bigint, jsonb) to authenticated;

create or replace function public.append_course_to_folder(
  p_course_id bigint,
  p_folder_id bigint
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  authenticated_user uuid := auth.uid();
  folder_chapter_id bigint;
  course_chapter_id bigint;
  current_folder_id bigint;
  next_position bigint;
begin
  if authenticated_user is null then
    raise exception 'Utilisateur non authentifié.'
      using errcode = '42501';
  end if;

  if p_course_id is null or p_folder_id is null then
    raise exception 'course_id et folder_id sont obligatoires.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.course_folders as folder
    where folder.id = p_folder_id
      and folder.user_id = authenticated_user
  ) then
    raise exception 'Dossier inaccessible.'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'folder_courses:' || authenticated_user::text || ':' || p_folder_id::text,
      0
    )
  );

  perform 1
  from public.course_folders as folder
  where folder.id = p_folder_id
    and folder.user_id = authenticated_user
  for update;

  select folder.chapter_id
  into folder_chapter_id
  from public.course_folders as folder
  where folder.id = p_folder_id
    and folder.user_id = authenticated_user;

  select course.chapter_id, course.folder_id
  into course_chapter_id, current_folder_id
  from public.courses as course
  where course.id = p_course_id
    and course.user_id = authenticated_user
  for update;

  if not found then
    raise exception 'Cours inaccessible.'
      using errcode = '42501';
  end if;

  if current_folder_id = p_folder_id then
    raise exception 'Le cours appartient déjà à ce dossier.'
      using errcode = '22023';
  end if;

  if current_folder_id is not null then
    raise exception 'Le cours appartient déjà à un autre dossier.'
      using errcode = '22023';
  end if;

  if course_chapter_id <> folder_chapter_id then
    raise exception 'Le cours et le dossier doivent appartenir au même chapitre.'
      using errcode = '22023';
  end if;

  select coalesce(max(course.folder_position::bigint), -1) + 1
  into next_position
  from public.courses as course
  where course.folder_id = p_folder_id
    and course.user_id = authenticated_user;

  if next_position > 2147483647 then
    raise exception 'La position du cours dépasse la limite autorisée.'
      using errcode = '22003';
  end if;

  update public.courses as course
  set folder_id = p_folder_id,
      folder_position = next_position::integer
  where course.id = p_course_id
    and course.user_id = authenticated_user;

  return true;
end;
$$;

revoke all on function public.append_course_to_folder(bigint, bigint) from public;
grant execute on function public.append_course_to_folder(bigint, bigint) to authenticated;

create or replace function public.remove_course_from_folder(
  p_course_id bigint
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  authenticated_user uuid := auth.uid();
  source_folder_id bigint;
  source_chapter_id bigint;
  current_folder_id bigint;
  remaining_count integer;
  max_position bigint;
  temporary_base bigint;
begin
  if authenticated_user is null then
    raise exception 'Utilisateur non authentifié.'
      using errcode = '42501';
  end if;

  if p_course_id is null then
    raise exception 'course_id obligatoire.'
      using errcode = '22023';
  end if;

  select course.folder_id, course.chapter_id
  into source_folder_id, source_chapter_id
  from public.courses as course
  where course.id = p_course_id
    and course.user_id = authenticated_user;

  if not found then
    raise exception 'Cours inaccessible.'
      using errcode = '42501';
  end if;

  if source_folder_id is null then
    raise exception 'Le cours n’appartient à aucun dossier.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.course_folders as folder
    where folder.id = source_folder_id
      and folder.user_id = authenticated_user
  ) then
    raise exception 'Dossier source inaccessible.'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'folder_courses:' || authenticated_user::text || ':' || source_folder_id::text,
      0
    )
  );

  perform 1
  from public.course_folders as folder
  where folder.id = source_folder_id
    and folder.user_id = authenticated_user
  for update;

  perform 1
  from public.courses as course
  where course.id = p_course_id
    and course.user_id = authenticated_user
  for update;

  select course.folder_id
  into current_folder_id
  from public.courses as course
  where course.id = p_course_id
    and course.user_id = authenticated_user;

  if current_folder_id <> source_folder_id then
    raise exception 'Le dossier du cours a changé, veuillez réessayer.'
      using errcode = '40001';
  end if;

  update public.courses as course
  set folder_id = null,
      folder_position = null
  where course.id = p_course_id
    and course.user_id = authenticated_user;

  drop table if exists pg_temp.remove_folder_courses_positions;

  create temporary table remove_folder_courses_positions (
    course_id bigint primary key,
    new_position integer not null unique
  ) on commit drop;

  insert into remove_folder_courses_positions (course_id, new_position)
  select
    course.id,
    row_number() over (
      order by course.folder_position asc, course.id asc
    )::integer - 1
  from public.courses as course
  where course.folder_id = source_folder_id
    and course.user_id = authenticated_user;

  select count(*)
  into remaining_count
  from remove_folder_courses_positions;

  if remaining_count > 0 then
    select coalesce(max(course.folder_position::bigint), -1)
    into max_position
    from public.courses as course
    where course.folder_id = source_folder_id
      and course.user_id = authenticated_user;

    temporary_base := max_position + remaining_count + 1;

    if temporary_base + remaining_count - 1 > 2147483647 then
      raise exception 'Impossible de créer une plage temporaire de positions.'
        using errcode = '22003';
    end if;

    update public.courses as course
    set folder_position = (
      temporary_base + positions.new_position
    )::integer
    from remove_folder_courses_positions as positions
    where course.id = positions.course_id
      and course.folder_id = source_folder_id
      and course.user_id = authenticated_user;

    update public.courses as course
    set folder_position = positions.new_position
    from remove_folder_courses_positions as positions
    where course.id = positions.course_id
      and course.folder_id = source_folder_id
      and course.user_id = authenticated_user;
  end if;

  return true;
end;
$$;

revoke all on function public.remove_course_from_folder(bigint) from public;
grant execute on function public.remove_course_from_folder(bigint) to authenticated;

create or replace function public.move_course_to_folder(
  p_course_id bigint,
  p_folder_id bigint
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  authenticated_user uuid := auth.uid();
  source_folder_id bigint;
  source_chapter_id bigint;
  target_chapter_id bigint;
  current_folder_id bigint;
  next_position bigint;
  remaining_count integer;
  max_position bigint;
  temporary_base bigint;
begin
  if authenticated_user is null then
    raise exception 'Utilisateur non authentifié.'
      using errcode = '42501';
  end if;

  if p_course_id is null or p_folder_id is null then
    raise exception 'course_id et folder_id sont obligatoires.'
      using errcode = '22023';
  end if;

  select course.folder_id, course.chapter_id
  into source_folder_id, source_chapter_id
  from public.courses as course
  where course.id = p_course_id
    and course.user_id = authenticated_user;

  if not found then
    raise exception 'Cours inaccessible.'
      using errcode = '42501';
  end if;

  if source_folder_id is null then
    raise exception 'Le cours n’appartient à aucun dossier.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.course_folders as folder
    where folder.id = source_folder_id
      and folder.user_id = authenticated_user
  ) then
    raise exception 'Dossier source inaccessible.'
      using errcode = '42501';
  end if;

  select folder.chapter_id
  into target_chapter_id
  from public.course_folders as folder
  where folder.id = p_folder_id
    and folder.user_id = authenticated_user;

  if not found then
    raise exception 'Dossier de destination inaccessible.'
      using errcode = '42501';
  end if;

  if source_folder_id = p_folder_id then
    return true;
  end if;

  if source_chapter_id <> target_chapter_id then
    raise exception 'Le cours et le dossier de destination doivent appartenir au même chapitre.'
      using errcode = '22023';
  end if;

  -- Always acquire both folder locks in ascending id order.
  if source_folder_id < p_folder_id then
    perform pg_advisory_xact_lock(
      hashtextextended(
        'folder_courses:' || authenticated_user::text || ':' || source_folder_id::text,
        0
      )
    );
    perform pg_advisory_xact_lock(
      hashtextextended(
        'folder_courses:' || authenticated_user::text || ':' || p_folder_id::text,
        0
      )
    );
  else
    perform pg_advisory_xact_lock(
      hashtextextended(
        'folder_courses:' || authenticated_user::text || ':' || p_folder_id::text,
        0
      )
    );
    perform pg_advisory_xact_lock(
      hashtextextended(
        'folder_courses:' || authenticated_user::text || ':' || source_folder_id::text,
        0
      )
    );
  end if;

  perform 1
  from public.course_folders as folder
  where folder.id in (source_folder_id, p_folder_id)
    and folder.user_id = authenticated_user
  order by folder.id
  for update;

  perform 1
  from public.courses as course
  where course.id = p_course_id
    and course.user_id = authenticated_user
  for update;

  select course.folder_id
  into current_folder_id
  from public.courses as course
  where course.id = p_course_id
    and course.user_id = authenticated_user;

  if current_folder_id <> source_folder_id then
    raise exception 'Le dossier du cours a changé, veuillez réessayer.'
      using errcode = '40001';
  end if;

  update public.courses as course
  set folder_id = null,
      folder_position = null
  where course.id = p_course_id
    and course.user_id = authenticated_user;

  drop table if exists pg_temp.move_folder_courses_positions;

  create temporary table move_folder_courses_positions (
    course_id bigint primary key,
    new_position integer not null unique
  ) on commit drop;

  insert into move_folder_courses_positions (course_id, new_position)
  select
    course.id,
    row_number() over (
      order by course.folder_position asc, course.id asc
    )::integer - 1
  from public.courses as course
  where course.folder_id = source_folder_id
    and course.user_id = authenticated_user;

  select count(*)
  into remaining_count
  from move_folder_courses_positions;

  if remaining_count > 0 then
    select coalesce(max(course.folder_position::bigint), -1)
    into max_position
    from public.courses as course
    where course.folder_id = source_folder_id
      and course.user_id = authenticated_user;

    temporary_base := max_position + remaining_count + 1;

    if temporary_base + remaining_count - 1 > 2147483647 then
      raise exception 'Impossible de créer une plage temporaire de positions.'
        using errcode = '22003';
    end if;

    update public.courses as course
    set folder_position = (
      temporary_base + positions.new_position
    )::integer
    from move_folder_courses_positions as positions
    where course.id = positions.course_id
      and course.folder_id = source_folder_id
      and course.user_id = authenticated_user;

    update public.courses as course
    set folder_position = positions.new_position
    from move_folder_courses_positions as positions
    where course.id = positions.course_id
      and course.folder_id = source_folder_id
      and course.user_id = authenticated_user;
  end if;

  select coalesce(max(course.folder_position::bigint), -1) + 1
  into next_position
  from public.courses as course
  where course.folder_id = p_folder_id
    and course.user_id = authenticated_user;

  if next_position > 2147483647 then
    raise exception 'La position du cours dépasse la limite autorisée.'
      using errcode = '22003';
  end if;

  update public.courses as course
  set folder_id = p_folder_id,
      folder_position = next_position::integer
  where course.id = p_course_id
    and course.user_id = authenticated_user;

  return true;
end;
$$;

revoke all on function public.move_course_to_folder(bigint, bigint) from public;
grant execute on function public.move_course_to_folder(bigint, bigint) to authenticated;