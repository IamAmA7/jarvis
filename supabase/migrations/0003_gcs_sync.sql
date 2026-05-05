-- Migration: gcs_synced_files
-- Tracks audio recordings pulled from a GCS bucket by /api/cron/gcs-sync,
-- with their transcript and Claude-generated insights. Each row is a single
-- attempt at processing one bucket object — name+bucket is the natural key.
--
-- The table is written to by the service role (server-side only). Reads from
-- the browser go through RLS keyed on clerk_user_id.

create table if not exists public.gcs_synced_files (
  id            bigserial primary key,
  bucket        text        not null,
  name          text        not null,
  clerk_user_id text,
  size_bytes    bigint,
  content_type  text,
  recorded_at   timestamptz,
  transcript_text text,
  language      text,
  duration_sec  numeric,
  insights      jsonb,
  status        text        not null check (status in ('done', 'error')),
  error_message text,
  processed_at  timestamptz not null default now(),
  unique (bucket, name)
);

create index if not exists gcs_synced_files_bucket_recorded_idx
  on public.gcs_synced_files (bucket, recorded_at desc);

create index if not exists gcs_synced_files_user_idx
  on public.gcs_synced_files (clerk_user_id, processed_at desc);

alter table public.gcs_synced_files enable row level security;

drop policy if exists "gcs_synced_files_select_own" on public.gcs_synced_files;
create policy "gcs_synced_files_select_own"
  on public.gcs_synced_files
  for select
  to authenticated
  using (clerk_user_id = (auth.jwt() ->> 'sub'));
