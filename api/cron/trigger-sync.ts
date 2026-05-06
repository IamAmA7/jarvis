/**
 * Vercel Cron → GitHub Actions workflow_dispatch trigger.
 *
 * GitHub's own scheduled workflows are unreliable on the free tier (often
 * skipped during peak load). To get a guaranteed run every 5 minutes we use
 * Vercel Cron, which POSTs to GitHub's workflow_dispatch endpoint and kicks
 * off the heavy GCS sync workflow.
 *
 * Required env vars (Vercel project settings):
 *   GITHUB_PAT   GitHub Personal Access Token with the workflow scope.
 *   CRON_SECRET  auto-injected by Vercel Cron; do not set manually.
 */
export const config = { runtime: 'edge' };

const REPO = 'IamAmA7/jarvis';
const WORKFLOW_FILE = 'gcs-sync.yml';

export default async function handler(req: Request): Promise<Response> {
  const isVercelCron = req.headers.get('x-vercel-cron') === '1';
  const secret = process.env.CRON_SECRET;
  const matchesSecret = secret && req.headers.get('authorization') === 'Bearer ' + secret;
  if (!isVercelCron && !matchesSecret) {
    return jsonResponse(401, { ok: false, error: 'unauthorized' });
  }

  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    return jsonResponse(500, { ok: false, error: 'GITHUB_PAT env var is missing' });
  }

  const url =
    'https://api.github.com/repos/' + REPO +
    '/actions/workflows/' + WORKFLOW_FILE + '/dispatches';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + pat,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'jarvis-cron/1.0',
    },
    body: JSON.stringify({ ref: 'main' }),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    return jsonResponse(502, { ok: false, status: res.status, detail });
  }

  return jsonResponse(200, { ok: true, triggered_at: new Date().toISOString() });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
