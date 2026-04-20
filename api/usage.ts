/**
 * GET /api/usage — current-day usage + plan for the signed-in user.
 * Used by the client to render the burn-down in the header and gate features
 * before making an API call.
 */
import { errorResponse, json, requireUser } from './_lib/auth';
import { checkQuota } from './_lib/supabase';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    const q = await checkQuota(userId);
    return json(200, {
      plan: q.plan,
      usedSec: q.usedSec,
      limitSec: q.limitSec,
      usedInsights: q.usedInsights,
      limitInsights: q.limitInsights,
      allowed: q.allowed,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
