/**
 * GET /api/cloud — list signed-in user's GCS-synced recordings, plus any
 * recordings shared with this user's email via cloud_access_grants. Each
 * shared record carries a `sharedFromEmail` field so the UI can show a
 * "Поделено: alex@…" badge.
 */
import { errorResponse, HttpError, json, requireUser } from '../_lib/auth';
import { admin } from '../_lib/supabase';

export const config = { runtime: 'edge' };

const CLERK_API = 'https://api.clerk.com/v1';
const SELECT_COLS =
  'id,bucket,name,size_bytes,content_type,recorded_at,transcript_text,language,duration_sec,insights,status,error_message,processed_at,clerk_user_id';

interface ClerkUser {
  email_addresses?: Array<{ id: string; email_address: string }>;
  primary_email_address_id?: string;
}

async function fetchUserEmail(userId: string): Promise<string | null> {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) return null;
  try {
    const r = await fetch(`${CLERK_API}/users/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) return null;
    const data = (await r.json()) as ClerkUser;
    const primary = data.email_addresses?.find((e) => e.id === data.primary_email_address_id);
    const email = primary?.email_address || data.email_addresses?.[0]?.email_address;
    return email ? email.toLowerCase() : null;
  } catch {
    return null;
  }
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    const supa = admin();

    const ownPromise = supa
      .from('gcs_synced_files')
      .select(SELECT_COLS)
      .eq('clerk_user_id', userId)
      .order('recorded_at', { ascending: false, nullsFirst: false })
      .limit(500);

    const myEmail = await fetchUserEmail(userId);
    const grantsPromise = myEmail
      ? supa
          .from('cloud_access_grants')
          .select('owner_user_id, owner_email')
          .eq('shared_with_email', myEmail)
          .is('revoked_at', null)
      : Promise.resolve({ data: [] as { owner_user_id: string; owner_email: string }[], error: null });

    const [ownRes, grantsRes] = await Promise.all([ownPromise, grantsPromise]);
    if (ownRes.error) throw new HttpError(500, ownRes.error.message);
    const own: any[] = ownRes.data ?? [];
    const grants = grantsRes.error ? [] : grantsRes.data ?? [];

    const ownerEmailById = new Map<string, string>();
    for (const g of grants) ownerEmailById.set(g.owner_user_id, g.owner_email);

    let shared: any[] = [];
    if (ownerEmailById.size > 0) {
      const ownerIds = Array.from(ownerEmailById.keys());
      const { data: sharedData, error: sharedErr } = await supa
        .from('gcs_synced_files')
        .select(SELECT_COLS)
        .in('clerk_user_id', ownerIds)
        .neq('bucket', 'manual')
        .order('recorded_at', { ascending: false, nullsFirst: false })
        .limit(500);
      if (!sharedErr && sharedData) shared = sharedData;
    }

    // Tag each row. Strip clerk_user_id before returning (don't leak owner ids).
    const tagged: any[] = [
      ...own.map((r) => ({ ...r, clerk_user_id: undefined, sharedFromEmail: null as string | null })),
      ...shared.map((r) => ({ ...r, clerk_user_id: undefined, sharedFromEmail: ownerEmailById.get(r.clerk_user_id) ?? null })),
    ];

    tagged.sort((a, b) => {
      const ta = a.recorded_at ? new Date(a.recorded_at).getTime() : 0;
      const tb = b.recorded_at ? new Date(b.recorded_at).getTime() : 0;
      return tb - ta;
    });

    return json(200, { recordings: tagged });
  } catch (err) {
    return errorResponse(err);
  }
}
