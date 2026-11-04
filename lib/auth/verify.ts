/**
 * Request authentication.
 *
 * The existing /api/submit route takes `userId` straight from the request
 * body, which means any caller can attribute a submission to any user. Saves
 * and feedback must not inherit that, since they are per-user records that
 * feed a public score — so writes verify a real Supabase access token instead.
 *
 * The mobile app sends it as `Authorization: Bearer <session.access_token>`.
 */

import { supabase } from '@/lib/supabase/client';

export interface AuthedUser {
  id: string;
  email: string | null;
}

/** Pull the bearer token out of the Authorization header. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Verify the caller's token against Supabase.
 * Returns null when there is no token or it is invalid/expired.
 */
export async function getAuthedUser(
  request: Request
): Promise<AuthedUser | null> {
  const token = bearerToken(request);
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;

  // Unconfirmed accounts are not treated as signed in, matching the mobile
  // app's AuthProvider, which also requires email_confirmed_at.
  if (!data.user.email_confirmed_at) return null;

  return { id: data.user.id, email: data.user.email ?? null };
}

/** Constant-time-ish comparison for shared secrets. */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Authorize a scheduled job.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. The original cron
 * route only accepted PIPELINE_SECRET, so if those two env vars ever differed
 * the cron would silently 401 forever. Accept either.
 */
export function isAuthorizedCron(request: Request): boolean {
  const token = bearerToken(request);
  if (!token) return false;

  const accepted = [process.env.CRON_SECRET, process.env.PIPELINE_SECRET].filter(
    (s): s is string => typeof s === 'string' && s.length > 0
  );

  if (accepted.length === 0) {
    console.error('[Auth] No CRON_SECRET or PIPELINE_SECRET configured.');
    return false;
  }

  return accepted.some((secret) => secretsMatch(token, secret));
}
