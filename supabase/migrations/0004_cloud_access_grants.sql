-- Migration 0004: cloud_access_grants
-- Lets a recording owner grant view access to their CLOUD recordings (bucket != 'manual')
-- to specific email addresses. One row = one grant. The recipient sees all of the
-- owner's cloud recordings (current and future) until the grant is revoked.
--
-- Manual-uploads (bucket = 'manual') are NEVER shared via this mechanism --
-- those are owner-only.

create table if not exists public.cloud_access_grants (
  id bigserial primary key,
  owner_user_id text not null,
  owner_email text not null,
  shared_with_email text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (owner_user_id, shared_with_email)
);

create index if not exists cloud_access_grants_owner_idx
  on public.cloud_access_grants (owner_user_id) where revoked_at is null;

create index if not exists cloud_access_grants_recipient_idx
  on public.cloud_access_grants (shared_with_email) where revoked_at is null;

-- Lowercase emails on insert/update for case-insensitive matching.
create or replace function public.cloud_access_grants_normalise_email()
returns trigger
language plpgsql
as $$
begin
  new.shared_with_email := lower(trim(new.shared_with_email));
  new.owner_email := lower(trim(new.owner_email));
  return new;
end;
$$;

drop trigger if exists cloud_access_grants_normalise_email_trg on public.cloud_access_grants;
create trigger cloud_access_grants_normalise_email_trg
  before insert or update on public.cloud_access_grants
  for each row execute function public.cloud_access_grants_normalise_email();

alter table public.cloud_access_grants enable row level security;

-- Defense-in-depth. The API uses the service role and bypasses RLS, but if any
-- query ever reaches an RLS-evaluated context, only relevant rows are visible.
drop policy if exists "cloud_access_grants_select_own" on public.cloud_access_grants;
create policy "cloud_access_grants_select_own"
  on public.cloud_access_grants
  for select to authenticated
  using (owner_user_id = (auth.jwt() ->> 'sub'));

drop policy if exists "cloud_access_grants_select_incoming" on public.cloud_access_grants;
create policy "cloud_access_grants_select_incoming"
  on public.cloud_access_grants
  for select to authenticated
  using (shared_with_email = lower(auth.jwt() ->> 'email'));

drop policy if exists "cloud_access_grants_insert_own" on public.cloud_access_grants;
create policy "cloud_access_grants_insert_own"
  on public.cloud_access_grants
  for insert to authenticated
  with check (owner_user_id = (auth.jwt() ->> 'sub'));

drop policy if exists "cloud_access_grants_update_own" on public.cloud_access_grants;
create policy "cloud_access_grants_update_own"
  on public.cloud_access_grants
  for update to authenticated
  using (owner_user_id = (auth.jwt() ->> 'sub'))
  with check (owner_user_id = (auth.jwt() ->> 'sub'));

-- Update gcs_synced_files RLS: a recipient can SELECT cloud (non-manual) rows
-- of any owner who has granted them access via cloud_access_grants. Manual
-- uploads (bucket = 'manual') are never shared via this path.
drop policy if exists "gcs_synced_files_select_own" on public.gcs_synced_files;
drop policy if exists "gcs_synced_files_select" on public.gcs_synced_files;
create policy "gcs_synced_files_select"
  on public.gcs_synced_files
  for select to authenticated
  using (
    clerk_user_id = (auth.jwt() ->> 'sub')
    or (
      bucket <> 'manual'
      and exists (
        select 1
          from public.cloud_access_grants g
         where g.owner_user_id = public.gcs_synced_files.clerk_user_id
           and g.shared_with_email = lower(auth.jwt() ->> 'email')
           and g.revoked_at is null
      )
    )
  );
