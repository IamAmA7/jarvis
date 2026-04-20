/**
 * GET    /api/sessions/:id — full session: metadata + segments + insight
 * PATCH  /api/sessions/:id — update title/context/ended_at/duration/segments/insight
 * DELETE /api/sessions/:id — delete session (cascades to segments + insights)
 *
 * PATCH is used both mid-session (adding segments) and on completion (setting
 * ended_at + attaching the final insight). We accept a `segments` array and
 * diff against what's in the DB by `idx` so it's idempotent — the client can
 * retry with the same segments safely.
 */
import { errorResponse, HttpError, json, requireUser } from '../_lib/auth';
import { admin } from '../_lib/supabase';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    const id = new URL(req.url).pathname.split('/').pop();
    if (!id) throw new HttpError(400, 'Missing session id');

    if (req.method === 'GET') {
      const [{ data: session, error: sessErr }, { data: segs }, { data: ins }] = await Promise.all([
        admin()
          .from('sessions')
          .select('*')
          .eq('id', id)
          .eq('clerk_user_id', userId)
          .maybeSingle(),
        admin()
          .from('segments')
          .select('idx,start_sec,end_sec,text,speaker')
          .eq('session_id', id)
          .eq('clerk_user_id', userId)
          .order('idx', { ascending: true }),
        admin()
          .from('insights')
          .select('*')
          .eq('session_id', id)
          .eq('clerk_user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (sessErr) throw new HttpError(500, sessErr.message);
      if (!session) throw new HttpError(404, 'Session not found');
      return json(200, { session, segments: segs ?? [], insight: ins ?? null });
    }

    if (req.method === 'DELETE') {
      const { error } = await admin()
        .from('sessions')
        .delete()
        .eq('id', id)
        .eq('clerk_user_id', userId);
      if (error) throw new HttpError(500, error.message);
      return json(200, { ok: true });
    }

    if (req.method === 'PATCH') {
      const body = (await req.json()) as {
        title?: string;
        context?: string;
        ended_at?: string;
        duration_sec?: number;
        segments?: Array<{ idx: number; start: number; end: number; text: string; speaker?: string }>;
        insight?: {
          summary?: string[];
          action_items?: Array<{ action: string; owner: string | null; deadline: string | null }>;
          key_topics?: string[];
          open_questions?: string[];
          sentiment?: 'positive' | 'neutral' | 'tense';
          energy_level?: number;
          language_detected?: string;
        };
      };

      // Confirm ownership up-front so we don't partially write.
      const { data: owned } = await admin()
        .from('sessions')
        .select('id')
        .eq('id', id)
        .eq('clerk_user_id', userId)
        .maybeSingle();
      if (!owned) throw new HttpError(404, 'Session not found');

      const patch: Record<string, unknown> = {};
      if (typeof body.title === 'string') patch.title = body.title.slice(0, 200);
      if (typeof body.context === 'string') patch.context = body.context.slice(0, 4000);
      if (typeof body.ended_at === 'string') patch.ended_at = body.ended_at;
      if (typeof body.duration_sec === 'number') patch.duration_sec = Math.max(0, Math.round(body.duration_sec));
      if (Object.keys(patch).length > 0) {
        const { error } = await admin()
          .from('sessions')
          .update(patch)
          .eq('id', id)
          .eq('clerk_user_id', userId);
        if (error) throw new HttpError(500, error.message);
      }

      if (body.segments?.length) {
        const rows = body.segments.map((s) => ({
          session_id: id,
          clerk_user_id: userId,
          idx: s.idx,
          start_sec: s.start,
          end_sec: s.end,
          text: s.text,
          speaker: s.speaker ?? null,
        }));
        const { error } = await admin()
          .from('segments')
          .upsert(rows, { onConflict: 'session_id,idx' });
        if (error) throw new HttpError(500, error.message);
      }

      if (body.insight) {
        const ins = body.insight;
        const { error } = await admin()
          .from('insights')
          .insert({
            session_id: id,
            clerk_user_id: userId,
            summary: ins.summary ?? [],
            action_items: ins.action_items ?? [],
            key_topics: ins.key_topics ?? [],
            open_questions: ins.open_questions ?? [],
            sentiment: ins.sentiment ?? 'neutral',
            energy_level: ins.energy_level ?? 3,
            language_detected: ins.language_detected ?? 'mixed',
          });
        if (error) throw new HttpError(500, error.message);
      }

      return json(200, { ok: true });
    }

    throw new HttpError(405, 'Method not allowed');
  } catch (err) {
    return errorResponse(err);
  }
}
