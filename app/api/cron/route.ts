/**
 * GET /api/cron — drain the submission queue.
 *
 * COMPLIANCE NOTE, since this is the route most likely to be mistaken for
 * something it is not:
 *
 * This job processes a queue of URLs THAT USERS SUBMITTED. It does not search
 * TikTok, crawl hashtags, enumerate creators, collect comments, or download
 * video files. It reads `raw_submissions` where status = 'pending' — rows that
 * only exist because somebody pasted a link into the app — and for each one
 * calls TikTok's public oEmbed endpoint for metadata and embed HTML.
 *
 * That is the opposite of the autonomous scanning the v2 strategy removed from
 * scope. Keep it that way: if a future change makes this route discover URLs
 * on its own rather than consume submitted ones, it has become a scraper and
 * is out of scope.
 *
 * ROLE IN THE QUEUE: this is the safety net, not the fast path. /api/submit
 * starts draining each row itself via `after()`, so in the normal case there
 * is nothing here to do. This exists for the cases that path cannot cover —
 * an invocation killed by the platform timeout, a row abandoned in
 * `processing`, or a transient Gemini/Places failure awaiting its retry.
 */

import type { NextRequest } from 'next/server';
import {
  getPendingSubmissions,
  requeueStuckSubmissions,
} from '@/lib/supabase/queries';
import { drainSubmission } from '@/lib/pipeline/worker';
import { QUEUE_CONFIG } from '@/lib/config/pipeline';
import { isAuthorizedCron } from '@/lib/auth/verify';
import { ok, unauthorized, serverError } from '@/lib/http/respond';

/** Gemini + Places + oEmbed per submission; give it room. */
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  // Accepts CRON_SECRET (what Vercel Cron actually sends) or PIPELINE_SECRET.
  // The previous version only accepted PIPELINE_SECRET, so if those two env
  // vars ever differed this job was silently 401ing on every run.
  if (!isAuthorizedCron(request)) {
    return unauthorized('Unauthorized');
  }

  try {
    // Rescue abandoned rows FIRST, so anything they release is available to
    // the drain below in this same run rather than waiting for the next one.
    const rescued = await requeueStuckSubmissions();
    if (rescued.requeued || rescued.failed) {
      console.log(
        `[Cron] Rescued ${rescued.requeued} stuck row(s), retired ${rescued.failed}`
      );
    }

    const pending = await getPendingSubmissions(QUEUE_CONFIG.batchSize);
    console.log(`[Cron] Draining ${pending.length} user-submitted link(s)`);

    // Sequential, not Promise.all. These rows each make an oEmbed call, two
    // Gemini calls and two Places calls; running five at once is the fastest
    // way to hit a provider rate limit and convert a batch of good
    // submissions into a batch of retries.
    const outcomes = [];
    for (const submission of pending) {
      // bypassGate: the cron IS the serial path, so the concurrency gate
      // that flattens bursts from /api/submit must not turn it away.
      outcomes.push(await drainSubmission(submission.id, { bypassGate: true }));
    }

    // A rejected submission is NOT a failure: "that video was not a
    // restaurant review" is a normal, expected outcome, and the previous
    // version counted it alongside genuine pipeline breakage.
    const tally = { completed: 0, rejected: 0, retry: 0, failed: 0, skipped: 0 };
    for (const o of outcomes) tally[o.status]++;

    return ok({
      processed: outcomes.length,
      ...tally,
      stuckRequeued: rescued.requeued,
      stuckRetired: rescued.failed,
      note: 'Processes user-submitted links only. No autonomous collection.',
    });
  } catch (err) {
    return serverError(err, 'API/cron');
  }
}
