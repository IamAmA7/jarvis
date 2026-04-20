/**
 * GET  /api/sessions            — list the signed-in user's sessions
 * POST /api/sessions            — create a new session (title, context)
 *
 * We go through the service-role client and filter by `clerk_user_id` by
 * hand. That costs one round-trip of trust in this file but keeps the hot
 * read path simple — no JWT->PostgREST header plumbing.
 */
import { errorResponse, HttpError, json, requireUser } from '../_lib/auth';
import { admin } from '../_lib/supabase';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);

    if (req.method === 'GET') {
      const { data, error } = await admin()
        .from('sessions')
        .select('id,title,context,language,model,started_at,ended_at,duration_sec,created_at,updated_at')
        .eq('clerk_user_id', userId)
        .order('started_at', { ascending: false })
        .limit(200);
      if (error) throw new HttpError(500, error.message);
      return json(200, { sessions: data ?? [] });
    }

    if (req.method === 'POST') {
      const body = (await req.json()) as { title?: string; context?: string; language?: string; model?: string };
      const { data, error } = await admin()
        .from('sessions')
        .insert({
          clerk_user_id: userId,
          title: body.title?.slice(0, 200) || 'Untitled session',
          context: body.context?.slice(0, 4000) ?? null,
          language: body.language ?? 'auto',
          model: body.model ?? 'claude-sonnet-4-6',
          started_at: new Date().toISOString(),
        })
        .select('id,title,context,language,model,started_at,ended_at,duration_sec,created_at,updated_at')
        .single();
      if (error) throw new HttpError(500, error.message);
      return json(201, data);
    }

    throw new HttpError(405, 'Method not allowed');
  } catch (err) {
    return errorResponse(err);
  }
}
