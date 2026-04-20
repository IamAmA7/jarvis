/**
 * Browser-side Supabase client factory.
 *
 * Today, all data access in the browser is routed through `/api/*` so we don't
 * actually construct a Supabase client in the page. This helper is kept for
 * the day we add a direct-to-Supabase read path (realtime, presence). When
 * you do, always call `supabase(token)` with a fresh Clerk JWT — the anon key
 * alone is safe, but our RLS requires a `sub` claim in the Authorization
 * header to match rows on `clerk_user_id`.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Cache one client per token so Realtime / PostgREST connections aren't rebuilt
// on every render. The `null` key covers the anon-only case.
const clients = new Map<string, SupabaseClient>();

export function supabase(token?: string | null): SupabaseClient {
  if (!url || !key) {
    throw new Error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not configured');
  }
  const cacheKey = token ?? '';
  const existing = clients.get(cacheKey);
  if (existing) return existing;
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  clients.set(cacheKey, client);
  return client;
}

export const isSupabaseConfigured = Boolean(url && key);
