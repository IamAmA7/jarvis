/**
 * POST /api/stripe/checkout — start a Stripe Checkout session for the Pro plan.
 * Returns `{ url }` — the client does `window.location.href = url`.
 */
import { errorResponse, HttpError, json, requireUser } from '../_lib/auth';
import { admin } from '../_lib/supabase';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const { userId } = await requireUser(req);

    const secret = process.env.STRIPE_SECRET_KEY;
    const priceId = process.env.STRIPE_PRICE_ID_PRO;
    const origin = req.headers.get('origin') ?? '';
    if (!secret || !priceId) throw new HttpError(500, 'Stripe not configured');

    // Reuse existing customer if we have one, else let Stripe create on checkout.
    const { data: sub } = await admin()
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('clerk_user_id', userId)
      .maybeSingle();

    const params = new URLSearchParams();
    params.set('mode', 'subscription');
    params.set('line_items[0][price]', priceId);
    params.set('line_items[0][quantity]', '1');
    params.set('success_url', `${origin}/billing?status=success`);
    params.set('cancel_url', `${origin}/billing?status=cancel`);
    params.set('client_reference_id', userId);
    params.set('metadata[clerk_user_id]', userId);
    if (sub?.stripe_customer_id) params.set('customer', sub.stripe_customer_id);
    params.set('allow_promotion_codes', 'true');

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new HttpError(res.status, `Stripe: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as { id: string; url: string };
    return json(200, { url: data.url, id: data.id });
  } catch (err) {
    return errorResponse(err);
  }
}
