/**
 * Server-side Supabase client.
 *
 * Uses the service_role key — so it bypasses RLS. Every call site is
 * responsible for filtering on `clerk_user_id` itself. Prefer the helpers
 * in this file over raw `.from()` calls so that ownership checks are
 * centralised.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function admin(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured');
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

export async function incrementUsage(
  userId: string,
  patch: { transcribeSec?: number; insightsCalls?: number },
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const { transcribeSec = 0, insightsCalls = 0 } = patch;
  if (transcribeSec === 0 && insightsCalls === 0) return;
  const { error } = await admin().rpc('bump_usage', {
    p_user: userId,
    p_day: today,
    p_transcribe_sec: transcribeSec,
    p_insights_calls: insightsCalls,
  });
  if (error) {
    // eslint-disable-next-line no-console
    console.error('[usage] bump_usage RPC failed', error.message);
    throw new Error(`bump_usage failed: ${error.message}`);
  }
}

// Free-tier limits. Transcription cap is seconds-of-audio per UTC day; insights
// cap is number of Claude calls per UTC day. Both are enforced server-side.
export const FREE_DAILY_SEC = 60 * 60; // 60 minutes of transcription.
export const FREE_DAILY_INSIGHTS = 100; // 100 insight refreshes.

export interface Quota {
  allowed: boolean;
  usedSec: number;
  usedInsights: number;
  limitSec: number | null;
  limitInsights: number | null;
  plan: 'free' | 'pro';
}

export async function checkQuota(userId: string): Promise<Quota> {
  const [{ data: sub }, { data: usage }] = await Promise.all([
    admin().from('subscriptions').select('plan, status').eq('clerk_user_id', userId).maybeSingle(),
    admin()
      .from('usage')
      .select('transcribe_sec, insights_calls')
      .eq('clerk_user_id', userId)
      .eq('day', new Date().toISOString().slice(0, 10))
      .maybeSingle(),
  ]);
  const plan = (sub?.plan === 'pro' && sub?.status === 'active' ? 'pro' : 'free') as 'free' | 'pro';
  const usedSec = usage?.transcribe_sec ?? 0;
  const usedInsights = usage?.insights_calls ?? 0;
  if (plan === 'pro') {
    return { allowed: true, usedSec, usedInsights, limitSec: null, limitInsights: null, plan };
  }
  const allowed = usedSec < FREE_DAILY_SEC && usedInsights < FREE_DAILY_INSIGHTS;
  return {
    allowed,
    usedSec,
    usedInsights,
    limitSec: FREE_DAILY_SEC,
    limitInsights: FREE_DAILY_INSIGHTS,
    plan,
  };
}
