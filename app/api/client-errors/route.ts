/**
 * POST /api/client-errors — a crash breadcrumb from the app.
 *
 * WHY NOT engagement_events: that table's `event_type` has a CHECK
 * constraint listing the allowed values, so a new 'client_error' type needs
 * a migration. Those are applied out of band here, and crash visibility
 * should not wait on one.
 *
 * So this writes nothing to the database. It `console.error`s a structured
 * line, which lands in the Vercel function logs where it is searchable and
 * can be forwarded to a log drain. That is enough to answer the question
 * that matters — "did the app crash for anyone, and where" — which we
 * currently cannot answer at all.
 *
 * A proper crash reporter (Sentry, or a client_errors table with a
 * retention policy) is the real answer. This is the cheap version that turns
 * a silent failure into a visible one.
 *
 * ── WHAT IS DELIBERATELY NOT ACCEPTED ──
 *
 * No user id, no email, no auth token, no screen contents. A crash report
 * should not become a backdoor for collecting what the person was looking
 * at. The anon id is accepted because it is already an opaque per-install
 * value, and it is the only way to tell "one person hitting this twenty
 * times" from "twenty people".
 */

import type { NextRequest } from 'next/server';
import { ok, badRequest, serverError } from '@/lib/http/respond';
import { inMemoryLimit, clientKey, tooManyRequests } from '@/lib/http/ratelimit';

/** Generous enough for a real stack, small enough not to be a payload vector. */
const MAX_MESSAGE = 500;
const MAX_STACK = 4000;
const MAX_CONTEXT = 200;

/**
 * A crashing app retries, and a crash loop would otherwise flood the logs
 * with the same trace — which is both a cost and the fastest way to make the
 * logs useless. Low on purpose.
 */
const REPORTS_PER_MINUTE = 10;

function clip(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

export async function POST(request: NextRequest) {
  try {
    const limit = inMemoryLimit(
      `client-errors:${clientKey(request)}`,
      REPORTS_PER_MINUTE,
      60_000
    );
    if (!limit.allowed) {
      return tooManyRequests('Too many reports.', limit.retryAfterSeconds);
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return badRequest('A JSON body is required');
    }

    const { message, stack, context, anonId, fatal, appVersion, platform } =
      body as Record<string, unknown>;

    const clipped = clip(message, MAX_MESSAGE);
    if (!clipped) return badRequest('message is required');

    console.error(
      '[ClientError]',
      JSON.stringify({
        fatal: Boolean(fatal),
        message: clipped,
        context: clip(context, MAX_CONTEXT),
        platform: clip(platform, 40),
        appVersion: clip(appVersion, 40),
        anonId: clip(anonId, 64),
        stack: clip(stack, MAX_STACK),
        at: new Date().toISOString(),
      })
    );

    // 202: accepted, nothing stored. The client must never block or retry on
    // the outcome of reporting its own crash.
    return ok({ ok: true }, { status: 202 });
  } catch (err) {
    return serverError(err, 'API/client-errors');
  }
}
