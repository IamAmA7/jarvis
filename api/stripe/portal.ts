/**
 * POST /api/stripe/portal — return a Stripe billing-portal URL for the user.
 * Used by the "Manage subscription" button.
 */
import { errorResponse, HttpError, json, requireUser } from '../_lib/auth';
import { admin } from '../_lib/supabase';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const { userId } = await requireUser(req);

    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) throw new HttpError(500, 'Stripe not configured');

    const { data: sub } = await admin()
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('clerk_user_id', userId)
      .maybeSingle();
    if (!sub?.stripe_customer_id) throw new HttpError(400, 'No Stripe customer on file');

    const origin = req.headers.get('origin') ?? '';
    const params = new URLSearchParams();
    params.set('customer', sub.stripe_customer_id);
    params.set('return_url', `${origin}/billing`);

    const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new HttpError(res.status, `Stripe portal: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as { url: string };
    return json(200, { url: data.url });
  } catch (err) {
    return errorResponse(err);
  }
}
