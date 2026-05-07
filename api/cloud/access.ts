/**
 * /api/cloud/access — manage cloud-access grants.
 *
 * GET    /api/cloud/access            list my outgoing grants (active only)
 * POST   /api/cloud/access  {email}   create or reactivate grant
 * DELETE /api/cloud/access?id=N       revoke grant (sets revoked_at)
 *
 * Owner = authenticated user. The recipient email does NOT need to belong to a
 * registered Clerk user yet — the grant simply waits. Once anyone signs in with
 * that email, /api/cloud will start including this owner's cloud records (via
 * RLS in 0004_cloud_access_grants migration plus the server-side join).
 */
import { errorResponse, HttpError, json, requireUser } from '../_lib/auth.js';
import { admin } from '../_lib/supabase.js';

export const config = { runtime: 'edge' };

const CLERK_API = 'https://api.clerk.com/v1';

interface ClerkUser {
  email_addresses?: Array<{ id: string; email_address: string }>;
  primary_email_address_id?: string;
}

async function getOwnerEmail(userId: string): Promise<string> {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) throw new HttpError(500, 'CLERK_SECRET_KEY not configured');
  const res = await fetch(`${CLERK_API}/users/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new HttpError(500, `Clerk user lookup failed: ${res.status} ${detail}`);
  }
  const data = (await res.json()) as ClerkUser;
  const primary = data.email_addresses?.find((e) => e.id === data.primary_email_address_id);
  const email = primary?.email_address || data.email_addresses?.[0]?.email_address;
  if (!email) throw new HttpError(500, 'Clerk user has no email on file');
  return email.toLowerCase();
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    const url = new URL(req.url);
    const supa = admin();

    if (req.method === 'GET') {
      const { data, error } = await supa
        .from('cloud_access_grants')
        .select('id, shared_with_email, created_at, revoked_at')
        .eq('owner_user_id', userId)
        .is('revoked_at', null)
        .order('created_at', { ascending: false });
      if (error) throw new HttpError(500, error.message);
      return json(200, { grants: data ?? [] });
    }

    if (req.method === 'POST') {
      const body = (await req.json().catch(() => null)) as { email?: string } | null;
      const email = (body?.email ?? '').trim().toLowerCase();
      if (!isValidEmail(email)) throw new HttpError(400, 'Введите корректный email');

      const ownerEmail = await getOwnerEmail(userId);
      if (email === ownerEmail) {
        throw new HttpError(400, 'Нельзя поделиться сам с собой');
      }

      // If a grant already exists for this owner+email pair, reactivate it
      // instead of inserting a duplicate (the unique index would reject it).
      const { data: existing } = await supa
        .from('cloud_access_grants')
        .select('id, revoked_at')
        .eq('owner_user_id', userId)
        .eq('shared_with_email', email)
        .maybeSingle();

      if (existing) {
        if (!existing.revoked_at) {
          return json(200, { id: existing.id, status: 'already_active' });
        }
        const { error: updErr } = await supa
          .from('cloud_access_grants')
          .update({ revoked_at: null, owner_email: ownerEmail })
          .eq('id', existing.id);
        if (updErr) throw new HttpError(500, updErr.message);
        return json(200, { id: existing.id, status: 'reactivated' });
      }

      const { data: inserted, error: insErr } = await supa
        .from('cloud_access_grants')
        .insert({
          owner_user_id: userId,
          owner_email: ownerEmail,
          shared_with_email: email,
        })
        .select('id')
        .single();
      if (insErr) throw new HttpError(500, insErr.message);
      return json(201, { id: inserted.id, status: 'created' });
    }

    if (req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) throw new HttpError(400, 'id required');
      const { error } = await supa
        .from('cloud_access_grants')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', id)
        .eq('owner_user_id', userId);
      if (error) throw new HttpError(500, error.message);
      return json(200, { ok: true });
    }

    throw new HttpError(405, 'Method not allowed');
  } catch (err) {
    return errorResponse(err);
  }
}
