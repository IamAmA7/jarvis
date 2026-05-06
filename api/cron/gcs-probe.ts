export const config = { runtime: 'nodejs', maxDuration: 10 };

export default async function handler(req) {
  const env = process.env;
  const sa = env.GCP_SERVICE_ACCOUNT_JSON || '';
  return new Response(
    JSON.stringify(
      {
        ok: true,
        method: req && req.method,
        timestamp: new Date().toISOString(),
        env: {
          bucket: env.GCP_BUCKET || null,
          sa_present: !!sa,
          sa_len: sa.length,
          sa_starts: sa.slice(0, 30),
          sa_has_pem_marker: sa.includes('BEGIN PRIVATE KEY'),
          sa_has_literal_backslash_n: sa.includes('\\n'),
          sa_has_real_newlines: sa.includes('\n'),
          supabase_url: !!env.SUPABASE_URL,
          vite_supabase_url: !!env.VITE_SUPABASE_URL,
          supabase_key: !!env.SUPABASE_SERVICE_ROLE_KEY,
          cron_secret: !!env.CRON_SECRET,
          openai: !!env.OPENAI_API_KEY,
          anthropic: !!env.ANTHROPIC_API_KEY,
        },
      },
      null,
      2,
    ),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
