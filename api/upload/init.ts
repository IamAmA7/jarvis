/**
 * POST /api/upload/init — initiate a direct browser → GCS upload.
 *
 * Browser uploads of audio files exceed Vercel's 4.5MB body limit, so we
 * mint a V2 signed PUT URL pointing at the same bucket the GCS sync cron
 * watches. The browser PUTs the file straight to GCS; the existing sync
 * picks it up on its next tick (≤5 min) and runs the standard
 * transcription + insights pipeline.
 *
 * The object is named `upload_<userPrefix>_<timestamp>_<filename>` so the
 * sync script (which infers ownership from the bucket) can keep its
 * single-user assumption while still letting us trace uploads back.
 *
 * The endpoint also ensures the bucket has CORS configured for browser PUTs.
 * This is idempotent — we only patch CORS if the existing config doesn't
 * already permit PUT from any origin.
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

async function importKey(sa: ServiceAccount): Promise<CryptoKey> {
  return importPKCS8(sa.private_key, 'RS256') as Promise<CryptoKey>;
}

async function getAccessToken(sa: ServiceAccount, key: CryptoKey, scope: string): Promise<string> {
  const tokenUri = sa.token_uri || GOOGLE_TOKEN_URL;
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

interface CorsRule {
  origin?: string[];
  method?: string[];
  responseHeader?: string[];
  maxAgeSeconds?: number;
}

async function ensureBucketCors(token: string): Promise<void> {
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(BUCKET)}?fields=cors`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    return;
  }
  const data = (await res.json()) as { cors?: CorsRule[] };
  const existing = Array.isArray(data.cors) ? data.cors : [];
  const allowsPut = existing.some(
    (c) => Array.isArray(c.method) && c.method.includes('PUT'),
  );
  if (allowsPut) return;
  const next: CorsRule[] = [
    ...existing,
    {
      origin: ['*'],
      method: ['PUT', 'POST', 'GET', 'HEAD', 'OPTIONS'],
      responseHeader: ['Content-Type', 'Content-Length', 'ETag', 'x-goog-resumable', 'x-goog-meta-*'],
      maxAgeSeconds: 3600,
    },
  ];
  await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(BUCKET)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ cors: next }),
  });
}

/** GCS V2 signed URL — simpler than V4 and still supported. */
async function signV2Put(
  sa: ServiceAccount,
  key: CryptoKey,
  contentType: string,
  expiresUnix: number,
  resourcePath: string,
): Promise<string> {
  const stringToSign = `PUT\n\n${contentType}\n${expiresUnix}\n${resourcePath}`;
  const data = new TextEncoder().encode(stringToSign);
  const sigBuf = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, data);
  const bytes = new Uint8Array(sigBuf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  return encodeURIComponent(b64);
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

export default async function handler(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');

    const body = (await req.json().catch(() => null)) as
      | { filename?: string; contentType?: string; size?: number }
      | null;
    if (!body || !body.filename) throw new HttpError(400, 'filename required');

    const MAX_SIZE = 200 * 1024 * 1024;
    if (typeof body.size === 'number' && body.size > MAX_SIZE) {
      throw new HttpError(413, `Файл слишком большой (макс. 200 MB)`);
    }

    const filename = safeName(body.filename);
    const contentType = (body.contentType || 'application/octet-stream').slice(0, 100);

    const sa = loadServiceAccount();
    const key = await importKey(sa);

    const writeToken = await getAccessToken(sa, key, GCS_RW_SCOPE);
    await ensureBucketCors(writeToken);

    const userPrefix = userId.replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || 'anon';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const objectName = `upload_${userPrefix}_${ts}_${filename}`;

    const expires = Math.floor(Date.now() / 1000) + 600;
    const resourcePath = `/${BUCKET}/${encodeURIComponent(objectName).replace(/%2F/g, '/')}`;
    const sig = await signV2Put(sa, key, contentType, expires, resourcePath);

    const uploadUrl =
      `https://storage.googleapis.com${resourcePath}` +
      `?GoogleAccessId=${encodeURIComponent(sa.client_email)}` +
      `&Expires=${expires}` +
      `&Signature=${sig}`;

    return json(200, {
      uploadUrl,
      objectName,
      bucket: BUCKET,
      contentType,
      expiresAt: expires,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
