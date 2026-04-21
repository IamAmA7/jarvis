-- Jarvis — listener mode schema.
--
-- Adds the tables that back the always-on microphone device (ESP32-S3 or
-- similar) plus the automatic alert pipeline. The flow is:
--
--   device pushes audio chunk  →  public.chunks
--   server transcribes         →  public.transcripts
--   Claude classifies window   →  public.alerts (severity red/yellow/green)
--   red alert fires Telegram   →  uses public.telegram_subscriptions
--   daily cron emails yellow   →  same subscription table, severities[]
--
-- Auth model matches 0001: `clerk_user_id` text key everywhere, RLS against
-- `public.clerk_user_id()`. The service-role bypasses RLS and filters by hand
-- (see api/_lib/supabase.ts). Devices authenticate with their own HMAC token
-- stored as a SHA-256 hash in public.devices — never the raw token.

begin;

-- ————— devices —————
-- A single hardware unit (ESP32 pendant, etc.). `token_hash` is sha256 of the
-- raw device token we issue on first provisioning. Raw token is shown once to
-- the user during firmware flashing and never again.
create table if not exists public.devices (
  id                 uuid primary key default gen_random_uuid(),
  clerk_user_id      text not null,
  name               text not null default 'Device',
  token_hash         text not null unique,
  firmware_version   text,
  hardware_id        text,
  last_seen_at       timestamptz,
  last_ip            text,
  battery_pct        integer check (battery_pct between 0 and 100),
  wifi_rssi          integer,
  storage_used_mb    integer,
  revoked_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists devices_user_idx on public.devices (clerk_user_id, created_at desc);

-- ————— chunks —————
-- One raw audio blob as it arrived from a device. `storage_path` points into
-- the "audio" Supabase Storage bucket (private). We keep chunks for ~30 days
-- then archive or delete via a scheduled job.
create table if not exists public.chunks (
  id                     uuid primary key default gen_random_uuid(),
  device_id              uuid not null references public.devices(id) on delete cascade,
  clerk_user_id          text not null,
  recorded_at            timestamptz not null,
  received_at            timestamptz not null default now(),
  duration_sec           numeric(8,3) not null default 0,
  bytes                  integer not null default 0,
  storage_path           text,
  sample_rate            integer,
  mime_type              text,
  vad_score              real,
  transcription_status   text not null default 'pending'
    check (transcription_status in ('pending','transcribing','done','failed','skipped')),
  transcription_error    text,
  transcribed_at         timestamptz,
  created_at             timestamptz not null default now()
);

create index if not exists chunks_user_recorded_idx
  on public.chunks (clerk_user_id, recorded_at desc);
create index if not exists chunks_pending_idx
  on public.chunks (transcription_status) where transcription_status = 'pending';

-- ————— transcripts —————
-- Whisper output for one chunk. We keep raw `words` for timeline scrubbing.
create table if not exists public.transcripts (
  id              uuid primary key default gen_random_uuid(),
  chunk_id        uuid not null references public.chunks(id) on delete cascade,
  clerk_user_id   text not null,
  device_id       uuid not null references public.devices(id) on delete cascade,
  recorded_at     timestamptz not null,
  text            text not null,
  language        text,
  duration_sec    numeric(8,3),
  words           jsonb,
  model           text not null default 'whisper-1',
  created_at      timestamptz not null default now()
);

create index if not exists transcripts_user_recorded_idx
  on public.transcripts (clerk_user_id, recorded_at desc);
create index if not exists transcripts_device_idx
  on public.transcripts (device_id, recorded_at desc);

-- ————— alerts —————
-- Claude's classification of a transcript window. Severity drives notifier
-- behaviour (red → Telegram in minutes; yellow → daily digest; green → archive).
create table if not exists public.alerts (
  id                 uuid primary key default gen_random_uuid(),
  clerk_user_id      text not null,
  device_id          uuid references public.devices(id) on delete set null,
  window_start       timestamptz not null,
  window_end         timestamptz not null,
  severity           text not null check (severity in ('red','yellow','green')),
  category           text not null,
  summary            text not null,
  evidence           text,
  confidence         real,
  transcript_refs    uuid[] not null default '{}',
  notified_at        timestamptz,
  acknowledged_at    timestamptz,
  acknowledged_by    text,
  created_at         timestamptz not null default now()
);

create index if not exists alerts_user_created_idx
  on public.alerts (clerk_user_id, created_at desc);
create index if not exists alerts_user_severity_idx
  on public.alerts (clerk_user_id, severity, created_at desc);
create index if not exists alerts_pending_notify_idx
  on public.alerts (severity, notified_at) where notified_at is null;

-- ————— telegram_subscriptions —————
-- One row per (user, chat). A user can have multiple chats (e.g. personal +
-- shared with partner). `severities` is the allow-list: by default we push red
-- immediately; yellow comes through the digest cron.
create table if not exists public.telegram_subscriptions (
  id               uuid primary key default gen_random_uuid(),
  clerk_user_id    text not null,
  chat_id          text not null,
  label            text,
  severities       text[] not null default array['red'],
  link_code        text,            -- one-time code used by /start on the bot
  link_expires_at  timestamptz,
  verified_at      timestamptz,
  created_at       timestamptz not null default now(),
  unique (clerk_user_id, chat_id)
);

create index if not exists tg_sub_user_idx on public.telegram_subscriptions (clerk_user_id);
create unique index if not exists tg_sub_link_code_uq
  on public.telegram_subscriptions (link_code) where link_code is not null;

-- ————— alert_config —————
-- Per-user tuning: which red categories to fire on, quiet hours, language hint.
create table if not exists public.alert_config (
  clerk_user_id      text primary key,
  red_categories     text[] not null default array[
    'aggression','physical_violence','threats','screaming','panic',
    'weapons','drugs','sexual_content','suicide_mention','fall_or_pain'
  ],
  yellow_categories  text[] not null default array[
    'isolation','sadness','recurring_conflict','negative_peer_dynamic','bullying_signals'
  ],
  quiet_hours_start  time,
  quiet_hours_end    time,
  child_name         text,
  child_age          integer,
  language_hint      text not null default 'auto',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ————— RLS —————
alter table public.devices                 enable row level security;
alter table public.chunks                  enable row level security;
alter table public.transcripts             enable row level security;
alter table public.alerts                  enable row level security;
alter table public.telegram_subscriptions  enable row level security;
alter table public.alert_config            enable row level security;

drop policy if exists devices_owner on public.devices;
create policy devices_owner on public.devices
  for all using (clerk_user_id = public.clerk_user_id())
  with check (clerk_user_id = public.clerk_user_id());

drop policy if exists chunks_owner on public.chunks;
create policy chunks_owner on public.chunks
  for all using (clerk_user_id = public.clerk_user_id())
  with check (clerk_user_id = public.clerk_user_id());

drop policy if exists transcripts_owner on public.transcripts;
create policy transcripts_owner on public.transcripts
  for all using (clerk_user_id = public.clerk_user_id())
  with check (clerk_user_id = public.clerk_user_id());

drop policy if exists alerts_owner on public.alerts;
create policy alerts_owner on public.alerts
  for all using (clerk_user_id = public.clerk_user_id())
  with check (clerk_user_id = public.clerk_user_id());

drop policy if exists tg_sub_owner on public.telegram_subscriptions;
create policy tg_sub_owner on public.telegram_subscriptions
  for all using (clerk_user_id = public.clerk_user_id())
  with check (clerk_user_id = public.clerk_user_id());

drop policy if exists alert_config_owner on public.alert_config;
create policy alert_config_owner on public.alert_config
  for all using (clerk_user_id = public.clerk_user_id())
  with check (clerk_user_id = public.clerk_user_id());

-- ————— updated_at triggers —————
drop trigger if exists devices_touch on public.devices;
create trigger devices_touch before update on public.devices
  for each row execute function public.touch_updated_at();

drop trigger if exists alert_config_touch on public.alert_config;
create trigger alert_config_touch before update on public.alert_config
  for each row execute function public.touch_updated_at();

-- ————— RPCs —————

-- Mark a chunk as picked up for transcription. Returns true if this caller
-- acquired the row, false if another worker got there first. Prevents two
-- Edge invocations from racing to transcribe the same chunk.
create or replace function public.claim_chunk_for_transcription(p_chunk uuid)
  returns boolean language plpgsql security definer
  set search_path = public as $$
declare
  updated integer;
begin
  update public.chunks
    set transcription_status = 'transcribing'
    where id = p_chunk and transcription_status = 'pending';
  get diagnostics updated = row_count;
  return updated > 0;
end;
$$;

revoke all on function public.claim_chunk_for_transcription(uuid) from public;
grant execute on function public.claim_chunk_for_transcription(uuid) to service_role;

-- Fetch a window of transcripts for Claude classification. Returns the
-- concatenated text with per-segment separators and the chunk IDs included,
-- so the caller can tag the resulting alert with `transcript_refs`.
create or replace function public.transcript_window(
  p_user text,
  p_device uuid,
  p_from timestamptz,
  p_to timestamptz
) returns table (
  transcript_id uuid,
  chunk_id uuid,
  recorded_at timestamptz,
  duration_sec numeric,
  text text
) language sql stable
  security definer
  set search_path = public as $$
  select t.id, t.chunk_id, t.recorded_at, t.duration_sec, t.text
  from public.transcripts t
  where t.clerk_user_id = p_user
    and (p_device is null or t.device_id = p_device)
    and t.recorded_at >= p_from
    and t.recorded_at <  p_to
  order by t.recorded_at asc;
$$;

revoke all on function public.transcript_window(text, uuid, timestamptz, timestamptz) from public;
grant execute on function public.transcript_window(text, uuid, timestamptz, timestamptz) to service_role;

commit;
