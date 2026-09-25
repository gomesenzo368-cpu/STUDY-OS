-- Atomic RPC for persisting the mixed course/folder order of one chapter.
-- The function is SECURITY INVOKER and is not executed by this migration.
create or replace function public.reorder_chapter_items(
  p_chapter_id bigint,
  p_items jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  authenticated_user uuid := auth.uid();
  requested_count integer;
  current_count integer;
begin
  if authenticated_user is null then
    raise exception 'Utilisateur non authentifié.'
      using errcode = '42501';
  end if;

  if p_chapter_id is null then
    raise exception 'chapter_id obligatoire.'
      using errcode = '22023';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items doit être un tableau JSON.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.chapters as chapter
    where chapter.id = p_chapter_id
      and chapter.user_id = authenticated_user
  ) then
    raise exception 'Chapitre inaccessible.'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) as element(value)
    where jsonb_typeof(element.value) <> 'object'
       or coalesce(element.value ->> 'type', '') not in ('course', 'folder')
       or coalesce(element.value ->> 'id', '') !~ '^[1-9][0-9]*$'
  ) then
    raise exception 'Chaque élément doit contenir un type course/folder et un id positif.'
      using errcode = '22023';
  end if;

  drop table if exists pg_temp.reorder_chapter_items_request;
  drop table if exists pg_temp.reorder_chapter_items_current;

  create temporary table reorder_chapter_items_request (
    item_type text not null,
    item_id bigint not null,
    new_position integer not null,
    primary key (item_type, item_id),
    unique (new_position)
  ) on commit drop;

  insert into reorder_chapter_items_request (item_type, item_id, new_position)
  select
    element.value ->> 'type',
    (element.value ->> 'id')::bigint,
    element.ordinality::integer - 1
  from jsonb_array_elements(p_items) with ordinality as element(value, ordinality);

  create temporary table reorder_chapter_items_current (
    item_type text not null,
    item_id bigint not null,
    primary key (item_type, item_id)
  ) on commit drop;

  insert into reorder_chapter_items_current (item_type, item_id)
  select
    case when chapter_item.course_id is not null then 'course' else 'folder' end,
    coalesce(chapter_item.course_id, chapter_item.folder_id)
  from public.chapter_items as chapter_item
  where chapter_item.chapter_id = p_chapter_id
    and chapter_item.user_id = authenticated_user;

  select count(*) into requested_count
  from reorder_chapter_items_request;

  select count(*) into current_count
  from reorder_chapter_items_current;

  if requested_count <> current_count then
    raise exception 'La liste reçue ne correspond pas aux éléments du chapitre.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from reorder_chapter_items_request as requested
    left join reorder_chapter_items_current as current_item
      on current_item.item_type = requested.item_type
     and current_item.item_id = requested.item_id
    where current_item.item_id is null
  ) then
    raise exception 'La liste contient un élément absent du chapitre.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from reorder_chapter_items_current as current_item
    left join reorder_chapter_items_request as requested
      on requested.item_type = current_item.item_type
     and requested.item_id = current_item.item_id
    where requested.item_id is null
  ) then
    raise exception 'La liste ne contient pas tous les éléments du chapitre.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from reorder_chapter_items_request as requested
    where requested.item_type = 'course'
      and not exists (
        select 1
        from public.courses as course
        where course.id = requested.item_id
          and course.chapter_id = p_chapter_id
          and course.user_id = authenticated_user
      )
  ) then
    raise exception 'Un cours ne correspond pas à ce chapitre ou à cet utilisateur.'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from reorder_chapter_items_request as requested
    where requested.item_type = 'folder'
      and not exists (
        select 1
        from public.course_folders as folder
        where folder.id = requested.item_id
          and folder.chapter_id = p_chapter_id
          and folder.user_id = authenticated_user
      )
  ) then
    raise exception 'Un dossier ne correspond pas à ce chapitre ou à cet utilisateur.'
      using errcode = '42501';
  end if;

  -- Lock the complete chapter set before changing any position.
  perform 1
  from public.chapter_items as chapter_item
  where chapter_item.chapter_id = p_chapter_id
    and chapter_item.user_id = authenticated_user
  for update;

  -- Move every row outside the non-negative position range first. Because
  -- existing positions are non-negative, this cannot collide with the unique key.
  update public.chapter_items as chapter_item
  set position = -chapter_item.position - 1,
      updated_at = timezone('utc', now())
  where chapter_item.chapter_id = p_chapter_id
    and chapter_item.user_id = authenticated_user;

  update public.chapter_items as chapter_item
  set position = requested.new_position,
      updated_at = timezone('utc', now())
  from reorder_chapter_items_request as requested
  where chapter_item.chapter_id = p_chapter_id
    and chapter_item.user_id = authenticated_user
    and (
      (requested.item_type = 'course' and chapter_item.course_id = requested.item_id)
      or
      (requested.item_type = 'folder' and chapter_item.folder_id = requested.item_id)
    );

  return true;
end;
$$;

revoke all on function public.reorder_chapter_items(bigint, jsonb) from public;
grant execute on function public.reorder_chapter_items(bigint, jsonb) to authenticated;
