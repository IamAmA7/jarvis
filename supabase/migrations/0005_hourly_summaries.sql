-- Migration: hourly_summaries
-- Stores Claude-generated per-hour rollups of cloud recordings.
-- The cron at /api/cron/hourly-summary runs at :05 of each hour and
-- upserts one row per (clerk_user_id, hour_start). Written by service role;
-- browser reads go through RLS keyed on clerk_user_id.

create table if not exists public.hourly_summaries (
  id            bigserial primary key,
  clerk_user_id text        not null,
  hour_start    timestamptz not null,
  summary_text  text,
  record_count  integer     not null default 0,
  record_ids    jsonb       not null default '[]'::jsonb,
  status        text        not null check (status in ('ok', 'empty', 'error')),
  error_message text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (clerk_user_id, hour_start)
);

create index if not exists hourly_summaries_user_hour_idx
  on public.hourly_summaries (clerk_user_id, hour_start desc);

alter table public.hourly_summaries enable row level security;

drop policy if exists "hourly_summaries_select_own" on public.hourly_summaries;
create policy "hourly_summaries_select_own"
  on public.hourly_summaries
  for select
  to authenticated
  using (clerk_user_id = (auth.jwt() ->> 'sub'));
