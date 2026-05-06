/**
 * GET /api/cloud/audio?id=NN — stream a cloud-synced audio file from GCS.
 *
 * Authenticates the Clerk user, verifies the recording belongs to them via
 * `gcs_synced_files.clerk_user_id`, mints a GCS access token from the service
 * account and proxies the audio bytes back to the browser. The HTML5 <audio>
 * element on the platform fetches this endpoint to play the recording inline.
 */
import { SignJWT, importPKCS8 } from 'jose';

import { errorResponse, HttpError, requireUser } from '../_lib/auth';
import { admin } from '../_lib/supabase';

export const config = { runtime: 'edge' };

const GCS_READ_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_only';
const STORAGE_BASE = 'https://storage.googleapis.com/storage/v1';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

async function getAccessToken(): Promise<string> {
  const json = process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (!json) throw new HttpError(500, 'GCP_SERVICE_ACCOUNT_JSON env var is missing');
  const sa = JSON.parse(json) as { client_email?: string; private_key?: string; token_uri?: string };
  if (!sa.client_email || !sa.private_key) {
    throw new HttpError(500, 'service account JSON missing client_email/private_key');
  }
  const tokenUri = sa.token_uri || GOOGLE_TOKEN_URL;
  const pem = sa.private_key.replace(/\\n/g, '\n');
  const key = await importPKCS8(pem, 'RS256');
  const issuedAt = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: GCS_READ_SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience(tokenUri)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 3600)
    .sign(key);

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new HttpError(500, `Google token exchange failed: ${res.status} ${detail}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new HttpError(500, 'Google did not return access_token');
  return data.access_token;
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    if (req.method !== 'GET') throw new HttpError(405, 'GET only');

    const url = new URL(req.url);
    const idStr = url.searchParams.get('id');
    if (!idStr) throw new HttpError(400, 'id query param is required');
    const id = Number.parseInt(idStr, 10);
    if (!Number.isFinite(id)) throw new HttpError(400, 'id must be an integer');

    const { data, error } = await admin()
      .from('gcs_synced_files')
      .select('bucket, name, content_type, clerk_user_id')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!data) throw new HttpError(404, 'recording not found');
    if (data.clerk_user_id !== userId) throw new HttpError(403, 'forbidden');

    const token = await getAccessToken();
    const gcsUrl = `${STORAGE_BASE}/b/${encodeURIComponent(data.bucket)}/o/${encodeURIComponent(data.name)}?alt=media`;
    const gcsRes = await fetch(gcsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!gcsRes.ok) {
      const detail = (await gcsRes.text()).slice(0, 200);
      throw new HttpError(502, `GCS fetch failed: ${gcsRes.status} ${detail}`);
    }

    const headers = new Headers();
    headers.set('Content-Type', data.content_type || 'audio/wav');
    headers.set('Cache-Control', 'private, max-age=300');
    const len = gcsRes.headers.get('content-length');
    if (len) headers.set('Content-Length', len);
    return new Response(gcsRes.body, { status: 200, headers });
  } catch (err) {
    return errorResponse(err);
  }
}
