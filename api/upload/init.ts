/**
 * POST /api/upload/init — start a chunked browser → GCS upload.
 *
 * Direct browser → GCS uploads require bucket-level CORS, which our service
 * account may not have permission to configure. Instead we proxy uploads
 * through Vercel: this endpoint creates a GCS resumable upload session and
 * hands the session URL back to the client. The client then chunks the file
 * and POSTs each chunk to /api/upload/chunk, which forwards it to GCS with
 * the proper Content-Range. This avoids GCS CORS entirely (browser only
 * talks to our origin).
 *
 * The uploaded object lands in the same `aa_audio_2026` bucket the GCS
 * sync cron already watches — no changes to the sync pipeline.
 */
import { SignJWT, importPKCS8 } from 'jose';
import { errorResponse, HttpError, json, requireUser } from '../_lib/auth';

export const config = { runtime: 'edge' };

const GCS_RW_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BUCKET = process.env.GCS_BUCKET || 'aa_audio_2026';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function loadServiceAccount(): ServiceAccount {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new HttpError(500, 'GCP_SERVICE_ACCOUNT_JSON env var is missing');
  const sa = JSON.parse(raw) as Partial<ServiceAccount>;
  if (!sa.client_email || !sa.private_key) {
    throw new HttpError(500, 'service account JSON missing client_email/private_key');
  }
  return {
    client_email: sa.client_email,
    private_key: sa.private_key.replace(/\\n/g, '\n'),
    token_uri: sa.token_uri,
  };
}

async function getAccessToken(sa: ServiceAccount, scope: string): Promise<string> {
  const tokenUri = sa.token_uri || GOOGLE_TOKEN_URL;
  const key = await importPKCS8(sa.private_key, 'RS256');
  const issuedAt = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope })
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

function safeName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return cleaned || 'file';
}

async function startResumableSession(
  token: string,
  objectName: string,
  contentType: string,
  size: number,
): Promise<string> {
  const url =
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(BUCKET)}/o` +
    `?uploadType=resumable&name=${encodeURIComponent(objectName)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': contentType,
      'X-Upload-Content-Length': String(size),
    },
    body: JSON.stringify({ name: objectName, contentType }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new HttpError(502, `GCS resumable init failed: ${res.status} ${detail}`);
  }
  const sessionUrl = res.headers.get('Location') || res.headers.get('location');
  if (!sessionUrl) throw new HttpError(502, 'GCS did not return resumable session URL');
  return sessionUrl;
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');

    const body = (await req.json().catch(() => null)) as
      | { filename?: string; contentType?: string; size?: number }
      | null;
    if (!body || !body.filename || typeof body.size !== 'number') {
      throw new HttpError(400, 'filename and size required');
    }

    const MAX_SIZE = 500 * 1024 * 1024;
    if (body.size > MAX_SIZE) {
      throw new HttpError(413, 'Файл слишком большой (макс. 500 MB)');
    }

    const filename = safeName(body.filename);
    const contentType = (body.contentType || 'application/octet-stream').slice(0, 100);
    const userPrefix = userId.replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || 'anon';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const objectName = `upload_${userPrefix}_${ts}_${filename}`;

    const sa = loadServiceAccount();
    const token = await getAccessToken(sa, GCS_RW_SCOPE);
    const sessionUrl = await startResumableSession(token, objectName, contentType, body.size);

    return json(200, {
      sessionUrl,
      objectName,
      bucket: BUCKET,
      contentType,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
