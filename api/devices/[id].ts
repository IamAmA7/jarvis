/**
 * PATCH /api/devices/:id   — rename
 * DELETE /api/devices/:id  — revoke (sets revoked_at; keeps history)
 * POST /api/devices/:id/rotate — (via ?action=rotate) mint a new secret
 */
import { errorResponse, HttpError, json, requireUser } from '../_lib/auth';
import { mintDeviceToken } from '../_lib/device-auth';
import { admin } from '../_lib/supabase';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    const url = new URL(req.url);
    const id = url.pathname.split('/').pop();
    if (!id) throw new HttpError(400, 'Missing device id');

    // Ownership check once up front — every branch below assumes it passed.
    const { data: owned, error: ownErr } = await admin()
      .from('devices')
      .select('id')
      .eq('id', id)
      .eq('clerk_user_id', userId)
      .maybeSingle();
    if (ownErr) throw new HttpError(500, ownErr.message);
    if (!owned) throw new HttpError(404, 'Device not found');

    if (req.method === 'PATCH') {
      const body = (await req.json().catch(() => ({}))) as { name?: string };
      const name = (body.name ?? '').trim().slice(0, 80);
      if (!name) throw new HttpError(400, 'name is required');
      const { data, error } = await admin()
        .from('devices')
        .update({ name })
        .eq('id', id)
        .select('id,name,created_at')
        .single();
      if (error) throw new HttpError(500, error.message);
      return json(200, data);
    }

    if (req.method === 'DELETE') {
      const { error } = await admin()
        .from('devices')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw new HttpError(500, error.message);
      return json(200, { revoked: true });
    }

    if (req.method === 'POST' && url.searchParams.get('action') === 'rotate') {
      const { raw, hash } = await mintDeviceToken();
      const { error } = await admin()
        .from('devices')
        .update({ token_hash: hash, revoked_at: null })
        .eq('id', id);
      if (error) throw new HttpError(500, error.message);
      return json(200, {
        id,
        token: raw,
        auth_header: `Device ${id}.${raw}`,
        note: 'New token. Previous one is invalid.',
      });
    }

    throw new HttpError(405, 'Method not allowed');
  } catch (err) {
    return errorResponse(err);
  }
}
