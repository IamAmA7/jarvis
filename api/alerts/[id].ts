/**
 * GET    /api/alerts/:id         — single alert + referenced transcripts
 * POST   /api/alerts/:id/ack     — mark acknowledged
 */
import { errorResponse, HttpError, json, requireUser } from '../_lib/auth';
import { admin } from '../_lib/supabase';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const id = parts[2]; // /api/alerts/:id(/ack)?
    const action = parts[3] ?? null;
    if (!id) throw new HttpError(400, 'Missing alert id');

    if (req.method === 'GET' && !action) {
      const { data: alert, error } = await admin()
        .from('alerts')
        .select(
          'id,device_id,window_start,window_end,severity,category,summary,evidence,confidence,transcript_refs,notified_at,acknowledged_at,created_at',
        )
        .eq('id', id)
        .eq('clerk_user_id', userId)
        .maybeSingle();
      if (error) throw new HttpError(500, error.message);
      if (!alert) throw new HttpError(404, 'Alert not found');

      const refs = (alert.transcript_refs as string[] | null) ?? [];
      let transcripts: unknown[] = [];
      if (refs.length) {
        const { data: trs, error: trErr } = await admin()
          .from('transcripts')
          .select('id,chunk_id,recorded_at,duration_sec,text,language')
          .in('id', refs)
          .order('recorded_at', { ascending: true });
        if (trErr) throw new HttpError(500, trErr.message);
        transcripts = trs ?? [];
      }
      return json(200, { alert, transcripts });
    }

    if (req.method === 'POST' && action === 'ack') {
      const { error } = await admin()
        .from('alerts')
        .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: userId })
        .eq('id', id)
        .eq('clerk_user_id', userId);
      if (error) throw new HttpError(500, error.message);
      return json(200, { acknowledged: true });
    }

    throw new HttpError(405, 'Method not allowed');
  } catch (err) {
    return errorResponse(err);
  }
}
