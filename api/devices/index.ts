/**
 * GET  /api/devices            — list the signed-in user's devices
 * POST /api/devices            — provision a new device; returns raw token ONCE
 *
 * The raw device token is shown to the user exactly once in the dashboard so
 * they can paste it into the firmware flasher. We store only sha256(token) —
 * if lost, the user revokes and provisions a new one.
 */
import { errorResponse, HttpError, json, requireUser } from '../_lib/auth';
import { mintDeviceToken } from '../_lib/device-auth';
import { admin } from '../_lib/supabase';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);

    if (req.method === 'GET') {
      const { data, error } = await admin()
        .from('devices')
        .select(
          'id,name,firmware_version,hardware_id,last_seen_at,battery_pct,wifi_rssi,storage_used_mb,revoked_at,created_at',
        )
        .eq('clerk_user_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw new HttpError(500, error.message);
      return json(200, { devices: data ?? [] });
    }

    if (req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as {
        name?: string;
        hardware_id?: string;
      };
      const name = (body.name ?? '').trim().slice(0, 80) || 'Device';
      const hardwareId = (body.hardware_id ?? '').trim().slice(0, 80) || null;

      const { raw, hash } = await mintDeviceToken();
      const { data, error } = await admin()
        .from('devices')
        .insert({
          clerk_user_id: userId,
          name,
          hardware_id: hardwareId,
          token_hash: hash,
        })
        .select('id,name,created_at')
        .single();
      if (error) throw new HttpError(500, error.message);

      // Return the raw token exactly once.
      return json(201, {
        id: data.id,
        name: data.name,
        created_at: data.created_at,
        token: raw,
        auth_header: `Device ${data.id}.${raw}`,
        note: 'Save this token now. It cannot be retrieved again.',
      });
    }

    throw new HttpError(405, 'Method not allowed');
  } catch (err) {
    return errorResponse(err);
  }
}
