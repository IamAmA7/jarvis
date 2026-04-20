/**
 * GET /api/deepgram/token — mint a short-lived Deepgram API key.
 *
 * Why not use the long-lived key directly from the browser? Because giving
 * that key to the client would let anyone who reads DevTools use our
 * Deepgram budget. Instead, on each session start we ask the Deepgram API
 * for a scoped, 60-second key via `POST /v1/projects/:project/keys` with
 * `time_to_live_in_seconds: 60`. The client uses that to open a WebSocket.
 *
 * Requires env: DEEPGRAM_API_KEY (master), DEEPGRAM_PROJECT_ID.
 */
import { errorResponse, HttpError, json, requireUser } from '../_lib/auth';
import { checkQuota } from '../_lib/supabase';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    const quota = await checkQuota(userId);
    if (!quota.allowed) {
      return json(402, {
        error: 'Daily free-tier quota exceeded',
        usedSec: quota.usedSec,
        limitSec: quota.limitSec,
        usedInsights: quota.usedInsights,
        limitInsights: quota.limitInsights,
        plan: quota.plan,
      });
    }

    const apiKey = process.env.DEEPGRAM_API_KEY;
    const project = process.env.DEEPGRAM_PROJECT_ID;
    if (!apiKey || !project) throw new HttpError(500, 'Deepgram not configured');

    const res = await fetch(`https://api.deepgram.com/v1/projects/${project}/keys`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        comment: `jarvis user=${userId.slice(-8)} ts=${Date.now()}`,
        scopes: ['usage:write'],
        time_to_live_in_seconds: 60,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new HttpError(res.status, `Deepgram key mint failed: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { key: string; api_key_id: string };
    return json(200, { key: data.key, expiresInSec: 60 });
  } catch (err) {
    return errorResponse(err);
  }
}
