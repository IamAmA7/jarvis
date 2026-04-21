/**
 * Device auth — HMAC-style tokens for hardware clients.
 *
 * Flow:
 *   1. User creates a device in the web UI (POST /api/devices) — we generate
 *      a 32-byte random secret, store sha256(secret) in devices.token_hash,
 *      return the raw secret exactly once so the user can flash it to the
 *      firmware. If the secret is lost the device must be re-provisioned.
 *
 *   2. On every POST /api/ingest the firmware sends:
 *        Authorization: Device <device_id>.<raw_token>
 *      We split on `.`, look up the device by id, sha256 the incoming token,
 *      constant-time-compare against token_hash, reject if revoked.
 *
 * We use Web Crypto (edge-runtime-safe) throughout. Tokens are 32 bytes of
 * randomness encoded as base64url (~43 chars). Device ids are UUIDs.
 */
import { HttpError } from './auth';
import { admin } from './supabase';

export interface AuthedDevice {
  deviceId: string;
  userId: string;
  firmwareVersion: string | null;
}

/** Generate a fresh device token (raw + sha256 hex). Raw is shown once. */
export async function mintDeviceToken(): Promise<{ raw: string; hash: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const raw = base64url(bytes);
  const hash = await sha256Hex(raw);
  return { raw, hash };
}

/** Verify an Authorization: Device <id>.<token> header. Throws 401 on failure. */
export async function requireDevice(req: Request): Promise<AuthedDevice> {
  const header = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!header) throw new HttpError(401, 'Missing Authorization header');
  const match = /^device\s+([0-9a-f-]{36})\.([A-Za-z0-9_-]+)$/i.exec(header.trim());
  if (!match) throw new HttpError(401, 'Malformed Device credential');
  const [, deviceId, rawToken] = match;

  const presentedHash = await sha256Hex(rawToken);

  const { data, error } = await admin()
    .from('devices')
    .select('id, clerk_user_id, token_hash, revoked_at, firmware_version')
    .eq('id', deviceId)
    .maybeSingle();
  if (error) throw new HttpError(500, `devices lookup: ${error.message}`);
  if (!data) throw new HttpError(401, 'Unknown device');
  if (data.revoked_at) throw new HttpError(401, 'Device revoked');
  if (!timingSafeEqualHex(data.token_hash, presentedHash)) {
    throw new HttpError(401, 'Bad device token');
  }
  return {
    deviceId: data.id,
    userId: data.clerk_user_id,
    firmwareVersion: data.firmware_version ?? null,
  };
}

/** Record that a device just pinged us (battery, WiFi, IP, firmware). */
export async function touchDevice(
  deviceId: string,
  patch: {
    battery?: number | null;
    wifi?: number | null;
    ip?: string | null;
    firmware?: string | null;
  } = {},
): Promise<void> {
  const update: Record<string, unknown> = { last_seen_at: new Date().toISOString() };
  if (typeof patch.battery === 'number') update.battery_pct = clamp(patch.battery, 0, 100);
  if (typeof patch.wifi === 'number') update.wifi_rssi = patch.wifi;
  if (patch.ip) update.last_ip = patch.ip;
  if (patch.firmware) update.firmware_version = patch.firmware;
  const { error } = await admin().from('devices').update(update).eq('id', deviceId);
  if (error) {
    // eslint-disable-next-line no-console
    console.error('[device] touch failed', error.message);
  }
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
