/**
 * Supabase Storage helpers for the "audio" bucket.
 *
 * Bucket layout:
 *   audio/<clerk_user_id>/<device_id>/<yyyy>/<mm>/<dd>/<chunk_id>.<ext>
 *
 * Bucket is private. Only the service role writes, and the dashboard reads
 * via short-lived signed URLs minted through `signedUrl()`.
 */
import { admin } from './supabase';

const BUCKET = 'audio';

export async function ensureBucket(): Promise<void> {
  // Create the bucket on first use. Idempotent — Supabase ignores dup errors
  // when `public: false` matches existing state.
  const client = admin();
  const { data } = await client.storage.getBucket(BUCKET);
  if (data) return;
  await client.storage.createBucket(BUCKET, { public: false });
}

export function storageKey(
  userId: string,
  deviceId: string,
  chunkId: string,
  recordedAt: Date,
  ext: string,
): string {
  const yyyy = recordedAt.getUTCFullYear().toString();
  const mm = String(recordedAt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(recordedAt.getUTCDate()).padStart(2, '0');
  return `${userId}/${deviceId}/${yyyy}/${mm}/${dd}/${chunkId}.${ext}`;
}

export async function putChunk(
  key: string,
  body: ArrayBuffer | Blob,
  contentType: string,
): Promise<void> {
  const { error } = await admin().storage.from(BUCKET).upload(key, body, {
    contentType,
    upsert: false,
  });
  if (error) throw new Error(`storage upload: ${error.message}`);
}

export async function signedUrl(key: string, ttlSec = 300): Promise<string> {
  const { data, error } = await admin().storage.from(BUCKET).createSignedUrl(key, ttlSec);
  if (error) throw new Error(`storage sign: ${error.message}`);
  return data.signedUrl;
}

export function extFromMime(mime: string | undefined | null): string {
  if (!mime) return 'webm';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
  if (mime.includes('flac')) return 'flac';
  return 'webm';
}
