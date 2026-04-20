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
  // Upsert with RPC-style delta. We rely on a conflict target = (user, day).
  const { error } = await admin().rpc('bump_usage', {
    p_user: userId,
    p_day: today,
    p_transcribe_sec: transcribeSec,
    p_insights_calls: insightsCalls,
  });
  if (error) {
    // Fallback: if the RPC isn't installed, do a read-modify-write. Safe
    // enough for MVP; the RPC is the preferred path.
    const { data } = await admin()
      .from('usage')
      .select('transcribe_sec, insights_calls')
      .eq('clerk_user_id', userId)
      .eq('day', today)
      .maybeSingle();
    const base = data ?? { transcribe_sec: 0, insights_calls: 0 };
    await admin()
      .from('usage')
      .upsert(
        {
          clerk_user_id: userId,
          day: today,
          transcribe_sec: base.transcribe_sec + transcribeSec,
          insights_calls: base.insights_calls + insightsCalls,
        },
        { onConflict: 'clerk_user_id,day' },
      );
  }
}

const FREE_TIER_DAILY_SEC = 60 * 60; // 60 minutes / day on the free plan.

export async function checkQuota(userId: string): Promise<{ allowed: boolean; usedSec: number; limitSec: number | null; plan: 'free' | 'pro' }> {
  const [{ data: sub }, { data: usage }] = await Promise.all([
    admin().from('subscriptions').select('plan, status').eq('clerk_user_id', userId).maybeSingle(),
    admin()
      .from('usage')
      .select('transcribe_sec')
      .eq('clerk_user_id', userId)
      .eq('day', new Date().toISOString().slice(0, 10))
      .maybeSingle(),
  ]);
  const plan = (sub?.plan === 'pro' && sub?.status === 'active' ? 'pro' : 'free') as 'free' | 'pro';
  const usedSec = usage?.transcribe_sec ?? 0;
  if (plan === 'pro') return { allowed: true, usedSec, limitSec: null, plan };
  return { allowed: usedSec < FREE_TIER_DAILY_SEC, usedSec, limitSec: FREE_TIER_DAILY_SEC, plan };
}
