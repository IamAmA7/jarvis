/**
 * POST /api/upload/init — get a Supabase Storage signed upload URL.
 *
 * Manual uploads are independent of the GCS cloud sync pipeline. The browser
 * uploads the file directly to Supabase Storage via the signed URL (CORS is
 * configured by Supabase out of the box), then calls /api/upload/finalize to
 * trigger transcription + insights. The GCS bucket and the cron that watches
 * it are completely untouched.
 */
import { errorResponse, HttpError, json, requireUser } from '../_lib/auth';
import { admin } from '../_lib/supabase';

export const config = { runtime: 'edge' };

const BUCKET = 'manual-uploads';
const MAX_SIZE = 500 * 1024 * 1024; // OpenAI Whisper single-call limit

function safeName(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[^\w.\-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'file'
  );
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
    if (body.size > MAX_SIZE) {
      throw new HttpError(
        413,
        `Файл слишком большой: ${(body.size / 1024 / 1024).toFixed(1)} MB. Лимит — ${MAX_SIZE / 1024 / 1024} MB (ограничение хранилища).`,
      );
    }

    const supa = admin();

    // Idempotent bucket creation. `createBucket` errors if it already exists,
    // which is fine — we ignore that case.
    try {
      await supa.storage.createBucket(BUCKET, {
        public: false,
        fileSizeLimit: MAX_SIZE,
      });
    } catch {
      /* bucket already exists */
    }

    const userPrefix = userId.replace(/[^A-Za-z0-9]/g, '') || 'anon';
    const ts = Date.now();
    const path = `${userPrefix}/${ts}_${safeName(body.filename)}`;

    const { data, error } = await supa.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data) {
      throw new HttpError(500, `Supabase signed URL failed: ${error?.message ?? 'unknown'}`);
    }

    return json(200, {
      signedUrl: data.signedUrl,
      path: data.path,
      token: data.token,
      bucket: BUCKET,
      contentType: body.contentType ?? 'application/octet-stream',
    });
  } catch (err) {
    return errorResponse(err);
  }
}
