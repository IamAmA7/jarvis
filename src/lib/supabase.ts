/**
 * Browser-side Supabase client.
 *
 * The anon key is safe to ship; RLS is what keeps other users' data out.
 * When a Clerk JWT is available we attach it via `global.headers` so that
 * `public.clerk_user_id()` can read it inside Postgres.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

let client: SupabaseClient | null = null;

export function supabase(token?: string | null): SupabaseClient {
  if (!url || !key) {
    throw new Error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not configured');
  }
  if (!client) {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  // Re-apply Authorization header if a new token is provided.
  if (token) {
    // @ts-expect-error — rest client exposes this internally
    client.rest.headers.Authorization = `Bearer ${token}`;
  }
  return client;
}

export const isSupabaseConfigured = Boolean(url && key);
