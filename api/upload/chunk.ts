/**
 * POST /api/upload/chunk — proxy a single chunk to a GCS resumable session.
 *
 * The browser cannot PUT directly to GCS (would require bucket-level CORS,
 * which our service account may not have permission to configure). Instead
 * the client splits the file into ≤3 MB chunks and POSTs each one to this
 * endpoint, which forwards to GCS with the proper Content-Range. GCS returns
 * 308 (Resume Incomplete) for non-final chunks and 200/201 for the chunk
 * that completes the upload — we surface both as 2xx so the client can keep
 * looping until offset === total.
 */
import { errorResponse, HttpError, requireUser } from '../_lib/auth';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  try {
    await requireUser(req);
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');

    const sessionUrlEnc = req.headers.get('x-session-url');
    const contentRange = req.headers.get('x-content-range');
    if (!sessionUrlEnc) throw new HttpError(400, 'X-Session-Url header required');
    if (!contentRange) throw new HttpError(400, 'X-Content-Range header required');

    const sessionUrl = decodeURIComponent(sessionUrlEnc);
    if (!sessionUrl.startsWith('https://storage.googleapis.com/')) {
      throw new HttpError(400, 'Invalid session URL host');
    }

    const buf = await req.arrayBuffer();
    if (buf.byteLength === 0) throw new HttpError(400, 'Empty chunk');

    const gcsRes = await fetch(sessionUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(buf.byteLength),
        'Content-Range': contentRange,
      },
      body: buf,
    });

    const detail = (await gcsRes.text()).slice(0, 300);

    // Pass GCS status verbatim so the client knows whether more chunks are
    // expected. 308 means "keep going"; 200/201 means "we're done".
    return new Response(
      JSON.stringify({
        status: gcsRes.status,
        range: gcsRes.headers.get('Range'),
        detail,
      }),
      {
        status: gcsRes.status === 308 ? 200 : gcsRes.status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
