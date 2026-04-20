/**
 * POST /api/stripe/webhook — Stripe subscription events → Supabase state.
 *
 * We care about four events:
 *   checkout.session.completed       → create/upgrade subscription row
 *   customer.subscription.updated    → plan or status changed
 *   customer.subscription.deleted    → downgrade to free
 *   invoice.payment_failed           → mark status=past_due
 *
 * This endpoint MUST run on Node runtime (not Edge) because we verify the
 * Stripe signature with HMAC-SHA256 over the raw body.
 */
import crypto from 'node:crypto';
import { admin } from '../_lib/supabase';

export const config = { runtime: 'nodejs' };

type StripeObject = Record<string, unknown>;
interface StripeEvent {
  id: string;
  type: string;
  data: { object: StripeObject };
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response('STRIPE_WEBHOOK_SECRET not configured', { status: 500 });

  const sig = req.headers.get('stripe-signature') ?? '';
  const body = await req.text();
  if (!verifySignature(body, sig, secret)) {
    return new Response('Invalid signature', { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(body) as StripeEvent;
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await onCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.updated':
      case 'customer.subscription.created':
        await onSubscriptionChange(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await onSubscriptionDeleted(event.data.object);
        break;
      case 'invoice.payment_failed':
        await onPaymentFailed(event.data.object);
        break;
      default:
        // Ignore — but acknowledge so Stripe stops retrying.
        break;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stripe webhook] handler failed', event.type, err);
    return new Response('Handler error', { status: 500 });
  }
  return new Response('ok');
}

function verifySignature(payload: string, header: string, secret: string): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  const signed = `${t}.${payload}`;
  const mac = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  const a = Buffer.from(mac, 'hex');
  const b = Buffer.from(v1, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function str(o: StripeObject, key: string): string | null {
  const v = o[key];
  return typeof v === 'string' ? v : null;
}

async function onCheckoutCompleted(o: StripeObject) {
  const userId = (o.client_reference_id as string) ?? ((o.metadata as StripeObject | undefined)?.clerk_user_id as string | undefined);
  const customerId = str(o, 'customer');
  const subId = str(o, 'subscription');
  if (!userId) return;
  await admin()
    .from('subscriptions')
    .upsert(
      {
        clerk_user_id: userId,
        stripe_customer_id: customerId,
        stripe_subscription_id: subId,
        plan: 'pro',
        status: 'active',
      },
      { onConflict: 'clerk_user_id' },
    );
}

async function onSubscriptionChange(o: StripeObject) {
  const subId = str(o, 'id');
  const customerId = str(o, 'customer');
  const status = str(o, 'status') ?? 'active';
  const periodEnd = typeof o.current_period_end === 'number' ? new Date((o.current_period_end as number) * 1000).toISOString() : null;
  const plan = status === 'active' || status === 'trialing' ? 'pro' : 'free';
  if (!customerId) return;
  await admin()
    .from('subscriptions')
    .update({
      stripe_subscription_id: subId,
      plan,
      status,
      current_period_end: periodEnd,
    })
    .eq('stripe_customer_id', customerId);
}

async function onSubscriptionDeleted(o: StripeObject) {
  const customerId = str(o, 'customer');
  if (!customerId) return;
  await admin()
    .from('subscriptions')
    .update({ plan: 'free', status: 'canceled', stripe_subscription_id: null })
    .eq('stripe_customer_id', customerId);
}

async function onPaymentFailed(o: StripeObject) {
  const customerId = str(o, 'customer');
  if (!customerId) return;
  await admin()
    .from('subscriptions')
    .update({ status: 'past_due' })
    .eq('stripe_customer_id', customerId);
}
