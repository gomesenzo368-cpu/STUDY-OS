alter table public.revision_answers
  add column if not exists snapshot_question_id bigint;

alter table public.revision_sessions
  add column if not exists snapshot_version smallint not null default 0
  check (snapshot_version in (0, 1));

update public.revision_answers
set snapshot_question_id = question_id
where snapshot_question_id is null
  and question_id is not null;

create table if not exists public.revision_session_questions (
  session_id bigint not null,
  question_id bigint not null,
  question_type text not null,
  question_text text not null,
  choices jsonb,
  position integer not null,
  constraint revision_session_questions_session_fk
    foreign key (session_id)
    references public.revision_sessions(id)
    on delete cascade,
  constraint revision_session_questions_type_check
    check (question_type in ('multiple_choice', 'true_false', 'short_answer')),
  constraint revision_session_questions_choices_check
    check (
      (question_type = 'multiple_choice'
        and choices is not null
        and jsonb_typeof(choices) = 'array')
      or (question_type in ('true_false', 'short_answer') and choices is null)
    ),
  constraint revision_session_questions_position_check
    check (position >= 0),
  constraint revision_session_questions_pkey
    primary key (session_id, question_id)
);

create table if not exists public.revision_session_question_keys (
  session_id bigint not null,
  question_id bigint not null,
  correct_answer jsonb not null,
  constraint revision_session_question_keys_question_fk
    foreign key (session_id, question_id)
    references public.revision_session_questions(session_id, question_id)
    on delete cascade,
  constraint revision_session_question_keys_pkey
    primary key (session_id, question_id)
);

create unique index if not exists revision_answers_session_snapshot_question_key
  on public.revision_answers (session_id, snapshot_question_id)
  where snapshot_question_id is not null;

create index if not exists revision_session_questions_session_position_idx
  on public.revision_session_questions (
    session_id,
    position,
    question_id
  );

insert into public.revision_session_questions (
  session_id,
  question_id,
  question_type,
  question_text,
  choices,
  position
)
select session.id,
       answer.snapshot_question_id,
       answer.question_type_snapshot,
       answer.question_text_snapshot,
       answer.choices_snapshot,
       coalesce(
         array_position(
           session.question_ids_snapshot,
           answer.snapshot_question_id
         ),
         0
       )
from public.revision_answers as answer
join public.revision_sessions as session on session.id = answer.session_id
where answer.snapshot_question_id is not null
  and answer.snapshot_question_id = any(session.question_ids_snapshot)
on conflict (session_id, question_id) do nothing;

alter table public.revision_session_questions enable row level security;
alter table public.revision_session_question_keys enable row level security;

drop policy if exists revision_session_questions_select_own
  on public.revision_session_questions;
create policy revision_session_questions_select_own
on public.revision_session_questions for select to authenticated
using (
  exists (
    select 1
    from public.revision_sessions as session
    where session.id = revision_session_questions.session_id
      and session.user_id = auth.uid()
  )
);

revoke all on table public.revision_session_questions from anon, authenticated;
revoke all on table public.revision_session_question_keys from anon, authenticated;
grant select on table public.revision_session_questions to authenticated;

create or replace function public.start_revision_session_snapshot(
  p_user_id uuid,
  p_course_id bigint
)
returns table (
  session_id bigint,
  course_id bigint,
  status text,
  total_questions integer,
  correct_answers integer,
  score numeric,
  started_at timestamptz,
  created_at timestamptz,
  questions jsonb
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_question_ids bigint[];
  v_session public.revision_sessions%rowtype;
  v_snapshot_count integer;
  v_key_count integer;
  v_questions jsonb;
begin
  if p_user_id is null or p_course_id is null then
    raise exception 'Session de révision invalide.' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.courses as course
    join public.chapters as chapter on chapter.id = course.chapter_id
    join public.subjects as subject on subject.id = chapter.subject_id
    where course.id = p_course_id
      and course.user_id = p_user_id
      and chapter.user_id = p_user_id
      and subject.user_id = p_user_id
      and (
        course.folder_id is null
        or exists (
          select 1
          from public.course_folders as folder
          where folder.id = course.folder_id
            and folder.chapter_id = chapter.id
            and folder.user_id = p_user_id
        )
      )
  ) then
    raise exception 'Cours introuvable.' using errcode = 'P0002';
  end if;

  perform question.id
  from public.revision_questions as question
  where question.course_id = p_course_id
  order by question.position, question.id
  for share;

  select coalesce(
    array_agg(question.id order by question.position, question.id),
    array[]::bigint[]
  )
  into v_question_ids
  from public.revision_questions as question
  where question.course_id = p_course_id;

  if cardinality(v_question_ids) = 0 then
    raise exception 'Ce cours ne contient aucune question.' using errcode = 'P0001';
  end if;

  select count(*)::integer,
         count(question_key.question_id)::integer
  into v_snapshot_count, v_key_count
  from public.revision_questions as question
  left join public.revision_question_keys as question_key
    on question_key.question_id = question.id
  where question.id = any(v_question_ids);

  if v_snapshot_count <> cardinality(v_question_ids)
     or v_key_count <> v_snapshot_count then
    raise exception 'Une question ne possède pas de clé de correction.' using errcode = 'P0001';
  end if;

  insert into public.revision_sessions (
    user_id,
    course_id,
    question_ids_snapshot,
    snapshot_version,
    status,
    total_questions,
    correct_answers,
    score,
    started_at
  )
  values (
    p_user_id,
    p_course_id,
    v_question_ids,
    1,
    'in_progress',
    cardinality(v_question_ids),
    0,
    0,
    pg_catalog.now()
  )
  returning * into v_session;

  insert into public.revision_session_questions (
    session_id, question_id, question_type, question_text, choices, position
  )
  select v_session.id,
         question.id,
         question.question_type,
         question.question_text,
         question.choices,
         question.position
  from public.revision_questions as question
  where question.id = any(v_question_ids);

  insert into public.revision_session_question_keys (session_id, question_id, correct_answer)
  select v_session.id, question_key.question_id, question_key.correct_answer
  from public.revision_question_keys as question_key
  where question_key.question_id = any(v_question_ids);

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'question_id', snapshot.question_id,
      'question_type', snapshot.question_type,
      'question_text', snapshot.question_text,
      'choices', snapshot.choices,
      'position', snapshot.position
    ) order by snapshot.position, snapshot.question_id
  )
  into v_questions
  from public.revision_session_questions as snapshot
  where snapshot.session_id = v_session.id;

  return query
  select v_session.id,
         v_session.course_id,
         v_session.status,
         v_session.total_questions,
         v_session.correct_answers,
         v_session.score,
         v_session.started_at,
         v_session.created_at,
         coalesce(v_questions, '[]'::jsonb);
end;
$$;

create or replace function public.revision_session_snapshot_status(
  p_user_id uuid,
  p_session_id bigint
)
returns table (snapshot_complete boolean)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_session public.revision_sessions%rowtype;
  v_snapshot_complete boolean;
begin
  select session.*
  into v_session
  from public.revision_sessions as session
  where session.id = p_session_id
    and session.user_id = p_user_id;

  if not found then
    raise exception 'Session introuvable.' using errcode = 'P0002';
  end if;

  select v_session.snapshot_version = 1
    and v_session.total_questions = cardinality(v_session.question_ids_snapshot)
    and (
      select count(*)
      from public.revision_session_questions as snapshot
      where snapshot.session_id = v_session.id
    ) = v_session.total_questions
    and not exists (
      select 1
      from unnest(v_session.question_ids_snapshot) as requested(question_id)
      where not exists (
        select 1
        from public.revision_session_questions as snapshot
        where snapshot.session_id = v_session.id
          and snapshot.question_id = requested.question_id
      )
    )
    and not exists (
      select 1
      from public.revision_session_questions as snapshot
      where snapshot.session_id = v_session.id
        and not (snapshot.question_id = any(v_session.question_ids_snapshot))
    )
    and not exists (
      select 1
      from public.revision_session_questions as snapshot
      where snapshot.session_id = v_session.id
        and not exists (
          select 1
          from public.revision_answers as revision_answer
          where revision_answer.session_id = v_session.id
            and revision_answer.snapshot_question_id = snapshot.question_id
        )
        and not exists (
          select 1
          from public.revision_session_question_keys as session_key
          where session_key.session_id = v_session.id
            and session_key.question_id = snapshot.question_id
        )
    )
  into v_snapshot_complete;

  return query select coalesce(v_snapshot_complete, false);
end;
$$;

create or replace function public.submit_revision_answer(
  p_user_id uuid,
  p_session_id bigint,
  p_question_id bigint,
  p_answer jsonb
)
returns table (
  is_correct boolean,
  answered_at timestamptz,
  correct_answers integer,
  total_questions integer,
  score numeric
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_session public.revision_sessions%rowtype;
  v_snapshot public.revision_session_questions%rowtype;
  v_correct_answer jsonb;
  v_is_correct boolean;
  v_answered_at timestamptz := pg_catalog.now();
  v_correct_count integer;
  v_score numeric(5, 2);
  v_answer_text text;
  v_correct_text text;
  v_source_question_id bigint;
begin
  select session.*
  into v_session
  from public.revision_sessions as session
  where session.id = p_session_id
    and session.user_id = p_user_id
  for update;

  if not found then
    raise exception 'Session introuvable.' using errcode = 'P0002';
  end if;
  if v_session.status <> 'in_progress' then
    raise exception 'La session est déjà terminée.' using errcode = '55000';
  end if;
  if v_session.snapshot_version <> 1 then
    raise exception 'Le snapshot de cette ancienne session est incomplet.' using errcode = 'P0003';
  end if;
  if p_question_id is null
     or not (p_question_id = any(v_session.question_ids_snapshot)) then
    raise exception 'Question introuvable dans cette session.' using errcode = 'P0002';
  end if;

  select snapshot.*
  into v_snapshot
  from public.revision_session_questions as snapshot
  where snapshot.session_id = v_session.id
    and snapshot.question_id = p_question_id
  for share;
  if not found then
    raise exception 'Le snapshot de cette ancienne session est incomplet.' using errcode = 'P0003';
  end if;

  if exists (
    select 1
    from public.revision_answers as revision_answer
    where revision_answer.session_id = v_session.id
      and revision_answer.snapshot_question_id = p_question_id
  ) then
    raise exception 'Une réponse existe déjà pour cette question.' using errcode = '23505';
  end if;

  select session_key.correct_answer
  into v_correct_answer
  from public.revision_session_question_keys as session_key
  where session_key.session_id = v_session.id
    and session_key.question_id = p_question_id;
  if not found then
    raise exception 'Le snapshot de cette ancienne session est incomplet.' using errcode = 'P0003';
  end if;

  case v_snapshot.question_type
    when 'multiple_choice' then
      if pg_catalog.jsonb_typeof(p_answer) is distinct from 'string'
         or not exists (
           select 1
           from pg_catalog.jsonb_array_elements(v_snapshot.choices) as option_value(value)
           where option_value.value ->> 'id' = p_answer #>> '{}'
         ) then
        raise exception 'Réponse QCM invalide.' using errcode = '22023';
      end if;
      v_is_correct := p_answer = v_correct_answer;
    when 'true_false' then
      if pg_catalog.jsonb_typeof(p_answer) is distinct from 'boolean' then
        raise exception 'Réponse vrai/faux invalide.' using errcode = '22023';
      end if;
      v_is_correct := p_answer = v_correct_answer;
    when 'short_answer' then
      if pg_catalog.jsonb_typeof(p_answer) is distinct from 'string'
         or pg_catalog.jsonb_typeof(v_correct_answer) is distinct from 'string' then
        raise exception 'Réponse courte invalide.' using errcode = '22023';
      end if;
      v_answer_text := pg_catalog.lower(
        pg_catalog.regexp_replace(
          pg_catalog.regexp_replace(p_answer #>> '{}', '^[[:space:]]+|[[:space:]]+$', '', 'g'),
          '[[:space:]]+', ' ', 'g'
        )
      );
      v_correct_text := pg_catalog.lower(
        pg_catalog.regexp_replace(
          pg_catalog.regexp_replace(v_correct_answer #>> '{}', '^[[:space:]]+|[[:space:]]+$', '', 'g'),
          '[[:space:]]+', ' ', 'g'
        )
      );
      v_is_correct := v_answer_text = v_correct_text;
    else
      raise exception 'Type de question invalide.' using errcode = '22023';
  end case;

  select question.id
  into v_source_question_id
  from public.revision_questions as question
  where question.id = p_question_id;

  insert into public.revision_answers (
    session_id,
    question_id,
    snapshot_question_id,
    question_text_snapshot,
    question_type_snapshot,
    choices_snapshot,
    answer,
    is_correct,
    answered_at
  )
  values (
    v_session.id,
    v_source_question_id,
    p_question_id,
    v_snapshot.question_text,
    v_snapshot.question_type,
    v_snapshot.choices,
    p_answer,
    v_is_correct,
    v_answered_at
  );

  select count(*) filter (where revision_answer.is_correct)::integer
  into v_correct_count
  from public.revision_answers as revision_answer
  where revision_answer.session_id = v_session.id;

  v_score := round(v_correct_count::numeric * 100 / v_session.total_questions, 2);

  update public.revision_sessions as session
  set correct_answers = v_correct_count,
      score = v_score
  where session.id = v_session.id
  returning
    session.correct_answers,
    session.total_questions,
    session.score
  into v_correct_count, total_questions, v_score;

  return query
  select v_is_correct, v_answered_at, v_correct_count, total_questions, v_score;
end;
$$;

revoke all on function public.start_revision_session(uuid, bigint)
  from public, anon, authenticated, service_role;

revoke all on function public.revision_session_snapshot_status(uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.revision_session_snapshot_status(uuid, bigint)
  to service_role;

revoke all on function public.start_revision_session_snapshot(uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.start_revision_session_snapshot(uuid, bigint)
  to service_role;

revoke all on function public.submit_revision_answer(uuid, bigint, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.submit_revision_answer(uuid, bigint, bigint, jsonb)
  to service_role;
