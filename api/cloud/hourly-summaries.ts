/**
 * GET /api/cloud/hourly-summaries
 *   Returns the authenticated user's hourly rollups in descending order.
 *   Query params:
 *     - limit (default 24, max 168)
 *     - days  (optional, restrict to last N days based on hour_start)
 *
 * Rows are produced by /api/cron/hourly-summary which runs every hour at :05.
 */
import { errorResponse, HttpError, json, requireUser } from '../_lib/auth.js';
import { admin } from '../_lib/supabase.js';

export const runtime = 'edge';

interface SummaryRow {
  hour_start: string;
  summary_text: string | null;
  record_count: number;
  status: 'ok' | 'empty' | 'error';
  error_message: string | null;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return errorResponse(new HttpError(405, 'Method not allowed'));
  }
  try {
    const { userId } = await requireUser(req);
    const url = new URL(req.url);

    const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '24', 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 24, 1), 168);

    let query = admin
      .from('hourly_summaries')
      .select('hour_start, summary_text, record_count, status, error_message')
      .eq('clerk_user_id', userId)
      .order('hour_start', { ascending: false })
      .limit(limit);

    const daysRaw = url.searchParams.get('days');
    if (daysRaw) {
      const days = Number.parseInt(daysRaw, 10);
      if (Number.isFinite(days) && days > 0 && days <= 90) {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        query = query.gte('hour_start', cutoff.toISOString());
      }
    }

    const { data, error } = await query;
    if (error) throw new HttpError(500, `Load failed: ${error.message}`);

    const rows = (data ?? []) as SummaryRow[];
    return json({ summaries: rows });
  } catch (err) {
    return errorResponse(err);
  }
}
