/**
 * Rate limiting for the public write endpoints.
 *
 * /api/submit, /api/events and /api/waitlist are reachable without an
 * account, and a submission costs real money: a Supadata credit, two Gemini
 * calls and up to two Places calls. Nothing stopped a loop.
 *
 * ── WHY TWO MECHANISMS ──
 *
 * Proper per-IP limiting needs shared state, which means a table, which means
 * a migration — applied out of band here. So this does the next best thing
 * and puts the durable limit where the money is:
 *
 *   /api/submit    counted against `raw_submissions`, which already records
 *                  every submission with a timestamp and a submitter. This is
 *                  durable, survives cold starts, and bounds spend directly,
 *                  because spend is proportional to rows in that table.
 *
 *   everything else  an in-memory token bucket, below. BEST EFFORT ONLY —
 *                  read the warning on `inMemoryLimit`.
 *
 * If a `rate_limits` table is added later, inMemoryLimit can be swapped for a
 * durable check without any caller changing.
 */

/**
 * In-memory fixed-window counter.
 *
 * HONEST ABOUT WHAT THIS IS: on serverless each instance has its own Map, so
 * the effective limit is `max` multiplied by however many instances are warm,
 * and a cold start resets it. It is not a security control. It stops an
 * accidental loop, a stuck retry and a casual script — which is most of what
 * actually happens — and it costs nothing. Do not rely on it to stop someone
 * who is trying.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

/** Stop the Map growing without bound on a long-lived instance. */
const MAX_TRACKED_KEYS = 5000;

export interface LimitResult {
  allowed: boolean;
  /** Seconds until the window resets; for the Retry-After header. */
  retryAfterSeconds: number;
  remaining: number;
}

export function inMemoryLimit(
  key: string,
  max: number,
  windowMs: number
): LimitResult {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    if (buckets.size >= MAX_TRACKED_KEYS) {
      // Drop expired entries first; if none are expired, clear the lot. A
      // cleared bucket means someone briefly gets extra allowance, which is
      // much better than growing memory until the instance dies.
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
      if (buckets.size >= MAX_TRACKED_KEYS) buckets.clear();
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0, remaining: max - 1 };
  }

  existing.count += 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));

  if (existing.count > max) {
    return { allowed: false, retryAfterSeconds, remaining: 0 };
  }
  return { allowed: true, retryAfterSeconds, remaining: max - existing.count };
}

/**
 * A key identifying the caller.
 *
 * Prefers the authenticated user id, because that is the only identifier a
 * caller cannot trivially change. Falls back to the left-most address in
 * `x-forwarded-for`, which on Vercel is the client as the edge saw it.
 *
 * `x-forwarded-for` IS spoofable in general — it is a request header — but
 * Vercel overwrites it at the edge, so the left-most entry is trustworthy
 * there. Behind any other proxy, it is not. Noted because the fallback looks
 * more authoritative than it is.
 */
export function clientKey(request: Request, userId?: string | null): string {
  if (userId) return `user:${userId}`;

  const forwarded = request.headers.get('x-forwarded-for') ?? '';
  const first = forwarded.split(',')[0]?.trim();
  if (first) return `ip:${first}`;

  const real = request.headers.get('x-real-ip')?.trim();
  if (real) return `ip:${real}`;

  // No usable identifier. One shared bucket is deliberately strict: it means
  // an unidentifiable flood is throttled as a group rather than waved
  // through individually.
  return 'ip:unknown';
}

/** 429 with a Retry-After header. */
export function tooManyRequests(message: string, retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({ error: message, retryAfterSeconds }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.max(1, retryAfterSeconds)),
      },
    }
  );
}

/** Limits, all env-overridable. */
function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const LIMITS = {
  /**
   * Submissions per signed-in user per hour, counted in the database.
   *
   * 20 is generous for a person pasting links they found, and it caps the
   * worst case at 20 Supadata credits plus 40 Gemini calls plus 40 Places
   * calls per account per hour.
   */
  submitPerUserPerHour: num('LIMIT_SUBMIT_PER_USER_HOUR', 20),

  /**
   * Anonymous submissions across the WHOLE SERVICE per hour.
   *
   * Anonymous callers cannot be told apart durably, so they share one budget.
   * Genuinely lower than the per-user limit: one shared bucket covering
   * everyone unidentified is a different thing from one person's allowance,
   * and an anonymous flood is the cheapest way to spend our money.
   *
   * 10/hour would have broken seeding, which is the next thing anyone does
   * with this: scripts/seed-submissions.ts sends no auth header, so a 40-link
   * run submits anonymously and would have stopped dead at the cap. The fix
   * is not a bigger number — it is that an operator call presenting
   * CRON_SECRET bypasses the limit entirely, and the seed script now sends
   * it. See the bypass in app/api/submit/route.ts.
   */
  submitAnonymousPerHour: num('LIMIT_SUBMIT_ANON_HOUR', 10),

  /** Analytics events per caller per minute. Cheap, but unbounded writes. */
  eventsPerMinute: num('LIMIT_EVENTS_PER_MINUTE', 60),

  /** Waitlist sign-ups per caller per hour. */
  waitlistPerHour: num('LIMIT_WAITLIST_PER_HOUR', 5),
} as const;
