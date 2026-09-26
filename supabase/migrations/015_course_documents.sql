create table if not exists public.course_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id bigint not null references public.courses(id) on delete restrict,
  original_filename text not null,
  storage_path text not null unique,
  mime_type text not null,
  file_size bigint not null check (file_size > 0),
  file_hash text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  document_type text not null check (document_type in ('image', 'pdf', 'text', 'word')),
  position integer not null check (position >= 0),
  status text not null default 'uploaded' check (status in ('uploaded', 'processing', 'ready', 'failed')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

grant select, insert, update, delete on public.course_documents to authenticated;

create index if not exists course_documents_course_order_idx
  on public.course_documents (user_id, course_id, position, created_at);

alter table public.course_documents enable row level security;

drop policy if exists course_documents_select_owned on public.course_documents;
create policy course_documents_select_owned on public.course_documents
for select using (
  auth.uid() = user_id
  and exists (
    select 1 from public.courses as course
    where course.id = course_documents.course_id
      and course.user_id = auth.uid()
  )
);

drop policy if exists course_documents_insert_owned on public.course_documents;
create policy course_documents_insert_owned on public.course_documents
for insert with check (
  auth.uid() = user_id
  and exists (
    select 1 from public.courses as course
    where course.id = course_documents.course_id
      and course.user_id = auth.uid()
  )
);

drop policy if exists course_documents_update_owned on public.course_documents;
create policy course_documents_update_owned on public.course_documents
for update using (
  auth.uid() = user_id
  and exists (
    select 1 from public.courses as course
    where course.id = course_documents.course_id
      and course.user_id = auth.uid()
  )
) with check (
  auth.uid() = user_id
  and exists (
    select 1 from public.courses as course
    where course.id = course_documents.course_id
      and course.user_id = auth.uid()
  )
);

drop policy if exists course_documents_delete_owned on public.course_documents;
create policy course_documents_delete_owned on public.course_documents
for delete using (
  auth.uid() = user_id
  and exists (
    select 1 from public.courses as course
    where course.id = course_documents.course_id
      and course.user_id = auth.uid()
  )
);

create or replace function public.set_course_documents_updated_at()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists course_documents_updated_at on public.course_documents;
create trigger course_documents_updated_at
before update on public.course_documents
for each row execute function public.set_course_documents_updated_at();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'course-originals',
  'course-originals',
  false,
  20971520,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists course_originals_insert_owned on storage.objects;
create policy course_originals_insert_owned on storage.objects
for insert to authenticated with check (
  bucket_id = 'course-originals'
  and split_part(name, '/', 1) = auth.uid()::text
  and exists (
    select 1 from public.course_documents as document
    join public.courses as course on course.id = document.course_id
    where document.storage_path = storage.objects.name
      and document.user_id = auth.uid()
      and course.user_id = auth.uid()
  )
);

drop policy if exists course_originals_select_owned on storage.objects;
create policy course_originals_select_owned on storage.objects
for select to authenticated using (
  bucket_id = 'course-originals'
  and split_part(name, '/', 1) = auth.uid()::text
  and exists (
    select 1 from public.course_documents as document
    join public.courses as course on course.id = document.course_id
    where document.storage_path = storage.objects.name
      and document.user_id = auth.uid()
      and course.user_id = auth.uid()
  )
);

drop policy if exists course_originals_delete_owned on storage.objects;
create policy course_originals_delete_owned on storage.objects
for delete to authenticated using (
  bucket_id = 'course-originals'
  and split_part(name, '/', 1) = auth.uid()::text
  and exists (
    select 1 from public.course_documents as document
    join public.courses as course on course.id = document.course_id
    where document.storage_path = storage.objects.name
      and document.user_id = auth.uid()
      and course.user_id = auth.uid()
  )
);