/**
 * GET  /api/alert_config  — current user config (with defaults applied)
 * PUT  /api/alert_config  — upsert
 *
 * Body fields: red_categories[], yellow_categories[], child_name,
 * child_age, language_hint, quiet_hours_start, quiet_hours_end.
 */
import { errorResponse, HttpError, json, requireUser } from './_lib/auth';
import { admin } from './_lib/supabase';

export const config = { runtime: 'edge' };

const DEFAULT_RED = [
  'aggression',
  'physical_violence',
  'threats',
  'screaming',
  'panic',
  'weapons',
  'drugs',
  'sexual_content',
  'suicide_mention',
  'fall_or_pain',
];
const DEFAULT_YELLOW = [
  'isolation',
  'sadness',
  'recurring_conflict',
  'negative_peer_dynamic',
  'bullying_signals',
];

export default async function handler(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);

    if (req.method === 'GET') {
      const { data, error } = await admin()
        .from('alert_config')
        .select(
          'red_categories,yellow_categories,child_name,child_age,language_hint,quiet_hours_start,quiet_hours_end,updated_at',
        )
        .eq('clerk_user_id', userId)
        .maybeSingle();
      if (error) throw new HttpError(500, error.message);
      return json(200, {
        red_categories: data?.red_categories ?? DEFAULT_RED,
        yellow_categories: data?.yellow_categories ?? DEFAULT_YELLOW,
        child_name: data?.child_name ?? null,
        child_age: data?.child_age ?? null,
        language_hint: data?.language_hint ?? 'auto',
        quiet_hours_start: data?.quiet_hours_start ?? null,
        quiet_hours_end: data?.quiet_hours_end ?? null,
        updated_at: data?.updated_at ?? null,
      });
    }

    if (req.method === 'PUT') {
      const body = (await req.json()) as {
        red_categories?: string[];
        yellow_categories?: string[];
        child_name?: string | null;
        child_age?: number | null;
        language_hint?: string;
        quiet_hours_start?: string | null;
        quiet_hours_end?: string | null;
      };
      const row = {
        clerk_user_id: userId,
        red_categories: sanitiseCategories(body.red_categories, DEFAULT_RED),
        yellow_categories: sanitiseCategories(body.yellow_categories, DEFAULT_YELLOW),
        child_name: (body.child_name ?? '').toString().trim().slice(0, 80) || null,
        child_age: typeof body.child_age === 'number' && body.child_age > 0 ? body.child_age : null,
        language_hint: (body.language_hint ?? 'auto').slice(0, 8),
        quiet_hours_start: body.quiet_hours_start ?? null,
        quiet_hours_end: body.quiet_hours_end ?? null,
      };
      const { error } = await admin().from('alert_config').upsert(row, {
        onConflict: 'clerk_user_id',
      });
      if (error) throw new HttpError(500, error.message);
      return json(200, { saved: true });
    }

    throw new HttpError(405, 'Method not allowed');
  } catch (err) {
    return errorResponse(err);
  }
}

function sanitiseCategories(input: unknown, fallback: string[]): string[] {
  if (!Array.isArray(input)) return fallback;
  const clean = input
    .map((x) => (typeof x === 'string' ? x.trim().slice(0, 64) : ''))
    .filter((x): x is string => !!x);
  return Array.from(new Set(clean)).slice(0, 50);
}
