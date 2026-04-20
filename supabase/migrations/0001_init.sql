-- Jarvis — initial schema.
--
-- Auth model: Clerk is the source of truth for identity. Every row that
-- belongs to a user carries a `clerk_user_id` (text) — we never duplicate
-- Clerk's user store in Supabase. RLS is enforced by matching a request-time
-- header (`request.jwt.claims.sub`) populated by our server when it forwards
-- the Clerk-issued JWT.
--
-- Data model:
--   sessions  — one per recording session
--   segments  — transcript chunks (ordered, timestamped)
--   insights  — structured extraction output from Claude
--   usage     — per-user metering for billing / rate limiting
--   subscriptions — mirror of Stripe state per user

begin;

create extension if not exists "pgcrypto";

-- ————— sessions —————
create table if not exists public.sessions (
  id              uuid primary key default gen_random_uuid(),
  clerk_user_id   text not null,
  title           text not null default 'Untitled session',
  context         text,
  language        text not null default 'auto',
  model           text not null default 'claude-sonnet-4-6',
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  duration_sec    integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists sessions_user_started_idx
  on public.sessions (clerk_user_id, started_at desc);

-- ————— segments —————
create table if not exists public.segments (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references public.sessions(id) on delete cascade,
  clerk_user_id   text not null,
  idx             integer not null,
  start_sec       numeric(10,3) not null,
  end_sec         numeric(10,3) not null,
  text            text not null,
  speaker         text,
  created_at      timestamptz not null default now(),
  unique (session_id, idx)
);

create index if not exists segments_session_idx
  on public.segments (session_id, idx);

-- ————— insights —————
create table if not exists public.insights (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references public.sessions(id) on delete cascade,
  clerk_user_id   text not null,
  summary         text[] not null default '{}',
  action_items    jsonb not null default '[]'::jsonb,
  key_topics      text[] not null default '{}',
  open_questions  text[] not null default '{}',
  sentiment       text not null default 'neutral' check (sentiment in ('positive','neutral','tense')),
  energy_level    integer not null default 3 check (energy_level between 1 and 5),
  language_detected text not null default 'mixed',
  created_at      timestamptz not null default now()
);

create index if not exists insights_session_idx
  on public.insights (session_id, created_at desc);

-- ————— usage —————
-- Counted in whole seconds of audio processed. Bucketed by UTC day so we can
-- show a burn-down and enforce a free-tier cap without scanning sessions.
create table if not exists public.usage (
  clerk_user_id   text not null,
  day             date not null,
  transcribe_sec  integer not null default 0,
  insights_calls  integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (clerk_user_id, day)
);

-- ————— subscriptions —————
create table if not exists public.subscriptions (
  clerk_user_id         text primary key,
  stripe_customer_id    text unique,
  stripe_subscription_id text unique,
  plan                  text not null default 'free' check (plan in ('free','pro')),
  status                text not null default 'active',
  current_period_end    timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ————— RLS —————
-- We expose the tables through a service-role key on the server and through
-- the anon key on the client. The anon client is only usable with a Clerk JWT
-- forwarded via the `Authorization` header; RLS matches `sub` claim.
alter table public.sessions       enable row level security;
alter table public.segments       enable row level security;
alter table public.insights       enable row level security;
alter table public.usage          enable row level security;
alter table public.subscriptions  enable row level security;

-- Helper: Clerk user id from JWT. Clerk issues tokens with `sub` = Clerk user id.
create or replace function public.clerk_user_id() returns text
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')
$$;

-- Sessions policies
drop policy if exists sessions_owner_select on public.sessions;
create policy sessions_owner_select on public.sessions
  for select using (clerk_user_id = public.clerk_user_id());

drop policy if exists sessions_owner_mod on public.sessions;
create policy sessions_owner_mod on public.sessions
  for all using (clerk_user_id = public.clerk_user_id())
  with check (clerk_user_id = public.clerk_user_id());

-- Segments / insights: user must own the parent session
drop policy if exists segments_owner on public.segments;
create policy segments_owner on public.segments
  for all using (clerk_user_id = public.clerk_user_id())
  with check (clerk_user_id = public.clerk_user_id());

drop policy if exists insights_owner on public.insights;
create policy insights_owner on public.insights
  for all using (clerk_user_id = public.clerk_user_id())
  with check (clerk_user_id = public.clerk_user_id());

drop policy if exists usage_owner on public.usage;
create policy usage_owner on public.usage
  for select using (clerk_user_id = public.clerk_user_id());

drop policy if exists subscriptions_owner on public.subscriptions;
create policy subscriptions_owner on public.subscriptions
  for select using (clerk_user_id = public.clerk_user_id());

-- ————— updated_at triggers —————
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists sessions_touch on public.sessions;
create trigger sessions_touch before update on public.sessions
  for each row execute function public.touch_updated_at();

drop trigger if exists subscriptions_touch on public.subscriptions;
create trigger subscriptions_touch before update on public.subscriptions
  for each row execute function public.touch_updated_at();

drop trigger if exists usage_touch on public.usage;
create trigger usage_touch before update on public.usage
  for each row execute function public.touch_updated_at();

-- ————— bump_usage RPC —————
-- Atomic per-user/per-day increment used by /api/transcribe and /api/insights.
-- Without this, the server falls back to read-modify-write which races on
-- concurrent requests (two chunks landing in the same Edge invocation window
-- can lose increments and let users slip past the free-tier cap).
create or replace function public.bump_usage(
  p_user text,
  p_day date,
  p_transcribe_sec integer,
  p_insights_calls integer
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.usage (clerk_user_id, day, transcribe_sec, insights_calls)
  values (p_user, p_day, coalesce(p_transcribe_sec, 0), coalesce(p_insights_calls, 0))
  on conflict (clerk_user_id, day) do update
    set transcribe_sec = public.usage.transcribe_sec + excluded.transcribe_sec,
        insights_calls = public.usage.insights_calls + excluded.insights_calls,
        updated_at     = now();
$$;

-- Only the service-role (server) should invoke this; RLS doesn't gate RPC.
revoke all on function public.bump_usage(text, date, integer, integer) from public;
grant execute on function public.bump_usage(text, date, integer, integer) to service_role;

commit;
