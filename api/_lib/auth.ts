/**
 * Server-side auth helper.
 *
 * Clerk issues a JWT to the browser; we forward it as a Bearer token on each
 * `/api/*` call. `requireUser` verifies the JWT against Clerk's JWKS and
 * returns the Clerk user id (the `sub` claim). On failure it throws a
 * `HttpError` that our handlers translate into 401 responses.
 *
 * We verify tokens with `jose` against Clerk's public JWKS. SECURITY: the
 * issuer MUST be pinned via CLERK_JWT_ISSUER. If we trusted the `iss` claim
 * from the token itself, an attacker could point us at their own Clerk-like
 * instance whose JWKS they control, and sign arbitrary `sub` values for any
 * user id — trivially forging authentication. So if CLERK_JWT_ISSUER is
 * missing we refuse all requests with a 500.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface AuthedUser {
  userId: string;
  sessionId: string | null;
  token: string;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(issuer: string) {
  let set = jwksCache.get(issuer);
  if (!set) {
    set = createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, '')}/.well-known/jwks.json`));
    jwksCache.set(issuer, set);
  }
  return set;
}

export async function requireUser(req: Request): Promise<AuthedUser> {
  const header = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    throw new HttpError(401, 'Missing Authorization header');
  }
  const token = header.slice(7).trim();
  if (!token) throw new HttpError(401, 'Empty bearer token');

  const payload = await verifyClerkToken(token);
  const userId = typeof payload.sub === 'string' ? payload.sub : null;
  if (!userId) throw new HttpError(401, 'Token has no subject');
  const sid = typeof payload.sid === 'string' ? payload.sid : null;
  return { userId, sessionId: sid, token };
}

async function verifyClerkToken(token: string): Promise<JWTPayload> {
  const expected = process.env.CLERK_JWT_ISSUER;
  if (!expected) {
    // Hard-fail — trusting the token's own `iss` claim is a forgery vector.
    throw new HttpError(500, 'CLERK_JWT_ISSUER not configured');
  }

  // Peek the issuer from the payload and compare against the pin BEFORE we
  // fetch JWKS. (Clerk tokens are unencrypted JWTs.)
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Malformed JWT');
  let payloadRaw: Record<string, unknown>;
  try {
    payloadRaw = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    throw new HttpError(401, 'Malformed JWT payload');
  }
  const iss = typeof payloadRaw.iss === 'string' ? payloadRaw.iss : null;
  if (!iss) throw new HttpError(401, 'Token missing issuer');
  if (iss !== expected) {
    throw new HttpError(401, `Issuer mismatch: ${iss}`);
  }

  try {
    const { payload } = await jwtVerify(token, jwksFor(expected), {
      issuer: expected,
      clockTolerance: 5,
    });
    return payload;
  } catch (err) {
    throw new HttpError(401, `JWT verification failed: ${(err as Error).message}`);
  }
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json(err.status, { error: err.message });
  const msg = err instanceof Error ? err.message : 'Internal error';
  // eslint-disable-next-line no-console
  console.error('[api] unhandled', err);
  return json(500, { error: msg });
}
