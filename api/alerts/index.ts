/**
 * GET /api/alerts  — list alerts for the dashboard.
 *
 * Query params:
 *   severity   — red | yellow | green | all (default: red,yellow)
 *   from       — ISO8601 lower bound on window_start (default: 7 days ago)
 *   to         — ISO8601 upper bound (default: now)
 *   device_id  — filter to one device
 *   limit      — max rows (default 100, cap 500)
 *   unacked    — "1" to include only acknowledged_at IS NULL
 */
import { errorResponse, HttpError, json, requireUser } from '../_lib/auth';
import { admin } from '../_lib/supabase';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== 'GET') throw new HttpError(405, 'GET only');
    const { userId } = await requireUser(req);
    const url = new URL(req.url);

    const severity = (url.searchParams.get('severity') ?? 'red,yellow').split(',').filter(Boolean);
    const allowed = new Set(['red', 'yellow', 'green']);
    const sevFilter = severity.includes('all')
      ? ['red', 'yellow', 'green']
      : severity.filter((s) => allowed.has(s));
    if (sevFilter.length === 0) return json(200, { alerts: [] });

    const from =
      url.searchParams.get('from') ??
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const to = url.searchParams.get('to') ?? new Date().toISOString();

    const deviceId = url.searchParams.get('device_id');
    const unacked = url.searchParams.get('unacked') === '1';
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));

    let query = admin()
      .from('alerts')
      .select(
        'id,device_id,window_start,window_end,severity,category,summary,evidence,confidence,transcript_refs,notified_at,acknowledged_at,created_at',
      )
      .eq('clerk_user_id', userId)
      .in('severity', sevFilter)
      .gte('window_start', from)
      .lte('window_start', to)
      .order('window_start', { ascending: false })
      .limit(limit);
    if (deviceId) query = query.eq('device_id', deviceId);
    if (unacked) query = query.is('acknowledged_at', null);

    const { data, error } = await query;
    if (error) throw new HttpError(500, error.message);
    return json(200, { alerts: data ?? [] });
  } catch (err) {
    return errorResponse(err);
  }
}
