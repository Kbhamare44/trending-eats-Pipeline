/**
 * POST /api/submit — a user hands us a TikTok link.
 *
 * This is the only way restaurants enter the system. It is user-initiated by
 * design: nothing in this codebase discovers videos on its own.
 *
 * What we do with the link: call TikTok's public oEmbed endpoint for metadata
 * and embed HTML, classify and extract from the CAPTION with Gemini, then
 * verify the restaurant against Google Places. We do not download the video,
 * and the embed is rendered in a WebView so playback stays with TikTok.
 *
 * THIS ROUTE NO LONGER PROCESSES THE LINK. It validates, deduplicates, writes
 * a `pending` row and returns — typically in well under a second. The pipeline
 * runs in the background (see lib/pipeline/worker.ts) and the app polls
 * GET /api/submissions/:id for the outcome.
 *
 * Why: processing inline meant a 10-30 second spinner, which users read as a
 * broken app, and a function timeout mid-pipeline left the row stranded in
 * `processing` with nothing to retry it.
 */

import type { NextRequest } from 'next/server';
import { after } from 'next/server';
import {
  createRawSubmission,
  findReviewByVideoId,
  findOpenSubmissionByUrl,
  countRecentSubmissions,
} from '@/lib/supabase/queries';
import { LIMITS, tooManyRequests } from '@/lib/http/ratelimit';
import { extractVideoId, isSubmittableTikTokUrl } from '@/lib/pipeline/tiktok';
import { drainSubmission } from '@/lib/pipeline/worker';
import { getAuthedUser, isAuthorizedCron } from '@/lib/auth/verify';
import { ok, badRequest, serverError } from '@/lib/http/respond';

/**
 * The HTTP response itself takes milliseconds, but work scheduled with
 * `after()` runs inside this same invocation and is bounded by the same limit,
 * so the pipeline needs the headroom. If the platform kills it anyway, the row
 * stays `processing` and requeueStuckSubmissions() rescues it.
 */
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return badRequest('A JSON body is required');
    }

    const { tiktokUrl } = body as Record<string, unknown>;

    if (typeof tiktokUrl !== 'string' || !tiktokUrl.trim()) {
      return badRequest('tiktokUrl is required');
    }

    const url = tiktokUrl.trim();

    // Parse the host properly rather than substring-matching "tiktok.com",
    // which would also accept something like https://tiktok.com.evil.test/x.
    if (!isSubmittableTikTokUrl(url)) {
      return badRequest('That does not look like a TikTok link');
    }

    // ── Dedupe before spending anything ────────────────
    // A link that already produced a review needs no pipeline run at all.
    // This is free (one indexed lookup) and saves an oEmbed call, two Gemini
    // calls and two Places calls per duplicate.
    const videoId = extractVideoId(url);
    if (videoId) {
      const existing = await findReviewByVideoId(videoId);
      if (existing) {
        return ok({
          submissionId: null,
          status: 'completed',
          duplicate: true,
          restaurantId: existing.restaurantId,
          restaurantName: existing.restaurantName,
          message: 'We already have this video.',
        });
      }
    }

    // Double-tapping Submit should return the first submission, not queue the
    // same work twice.
    const inFlight = await findOpenSubmissionByUrl(url);
    if (inFlight) {
      return ok({
        submissionId: inFlight.id,
        status: inFlight.status,
        duplicate: true,
        message: 'This link is already being processed.',
      });
    }

    // `userId` is not read from the body. It used to be, unverified, so any
    // caller could attribute submissions to any user — which also fed the
    // creator and trend stats. Anonymous submissions are allowed, with a null
    // submitter.
    const user = await getAuthedUser(request);

    // ── Rate limit ─────────────────────────────────────
    // Checked AFTER the dedupe lookups above, so re-pasting a link we already
    // have never counts against anyone's budget, and BEFORE anything is
    // written or any provider is called.
    //
    // Counted in the database rather than in memory: this is the endpoint
    // that spends money, so the limit has to survive a cold start.
    // An operator call — the seeding script — presents CRON_SECRET and is
    // exempt. Without this, seeding 25-40 links would stop at the anonymous
    // cap, because the seed script has no user to attribute submissions to.
    const isOperator = isAuthorizedCron(request);

    const HOUR = 60 * 60 * 1000;
    const limit = user
      ? LIMITS.submitPerUserPerHour
      : LIMITS.submitAnonymousPerHour;
    const recent = isOperator
      ? 0
      : await countRecentSubmissions(user?.id ?? null, HOUR);

    if (!isOperator && recent >= limit) {
      return tooManyRequests(
        user
          ? "That's a lot of links in one hour. Try again a bit later."
          : 'Too many anonymous submissions right now. Sign in to keep adding links.',
        3600
      );
    }

    const submissionId = await createRawSubmission(url, user?.id ?? null);

    // Fast path: start draining as soon as the response is on the wire. If
    // this invocation dies first, the row is simply left `pending` and the
    // cron picks it up — which is why this is best-effort and not awaited.
    after(async () => {
      try {
        const outcome = await drainSubmission(submissionId);
        console.log('[Submit/after]', JSON.stringify(outcome));
      } catch (err: any) {
        console.error('[Submit/after] unexpected:', err?.message ?? err);
      }
    });

    return ok({
      submissionId,
      status: 'pending',
      duplicate: false,
      message: "We're looking into this — it'll appear on the map shortly.",
    });
  } catch (err) {
    return serverError(err, 'API/submit');
  }
}
