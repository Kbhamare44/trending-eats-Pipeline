/**
 * The submission worker: the one place that owns a submission's lifecycle.
 *
 * WHY THIS EXISTS
 *
 * /api/submit used to run the whole pipeline inside the HTTP request — oEmbed,
 * two Gemini calls, two Places calls, aggregation, then a trend recompute.
 * That is 10-30 seconds with the user watching a spinner, and people assume a
 * 30-second spinner means the app is broken. Adding a transcript fetch would
 * have pushed it to 20-60.
 *
 * Worse, it was not even reliable: the route declared `maxDuration = 120`, but
 * a platform function timeout below that would kill the request mid-pipeline
 * and leave the row in `processing` with nothing to ever pick it up again.
 *
 * So submission is now enqueue-then-drain:
 *
 *   /api/submit        insert a `pending` row, return in under a second
 *   after()            drain it immediately in the same invocation, best effort
 *   /api/cron          drain whatever `after()` did not finish
 *   requeueStuck...()  rescue rows abandoned by a timeout
 *
 * The `after()` path is what makes submission feel instant; the cron is what
 * makes it correct. Neither alone is enough — `after()` runs inside the same
 * function invocation, so it is subject to the same timeout, and the cron on a
 * Vercel Hobby plan can only be scheduled once a day.
 *
 * STATUS OWNERSHIP
 *
 * processSubmission() writes the terminal states it can determine itself
 * (`rejected` for a non-review, `completed` on success) and throws on anything
 * else. This module writes `processing` (via the atomic claim) and decides
 * between retry and `failed`, because only it knows the attempt count.
 */

import { claimSubmission, releaseSubmission, getSubmissionById } from '@/lib/supabase/queries';
import { QUEUE_CONFIG } from '@/lib/config/pipeline';
import { processSubmission, type ProcessingResult } from './processor';
import { aggregateRestaurantReviews } from './aggregator';
import { syncRestaurantDishes } from '@/lib/dishes/aggregate';
import { recomputeRestaurantTrends } from '@/lib/trends/recompute';

/**
 * Concurrent drains allowed in this process.
 *
 * WHY THIS IS NEEDED, and it is a regression the async rewrite introduced:
 * before it, /api/submit ran the pipeline inside the request, so a seeding
 * script that waits 3 seconds between links genuinely serialised — each
 * submission blocked for the 15-30 seconds the pipeline took. Now submit
 * returns in under a second and the work happens in `after()`, so the same
 * script starts a new pipeline every 3 seconds while roughly seven are still
 * running. Each one costs a Supadata credit, two Gemini calls and two Places
 * calls, so a 40-link seeding run would hammer every provider at once and
 * convert a batch of good submissions into rate-limited retries.
 *
 * When the gate is full, drainSubmission returns WITHOUT claiming the row.
 * That is the important part: the row stays `pending`, so the cron picks it
 * up and processes it serially. Nothing is lost, the burst just flattens.
 *
 * Per-process, so it does not bound total concurrency across instances — but
 * Vercel reuses a warm instance for a burst from one client, which is exactly
 * the seeding case.
 */
let activeDrains = 0;

export interface DrainOutcome {
  submissionId: string;
  /** False when another worker already held the row. */
  claimed: boolean;
  status: 'completed' | 'rejected' | 'retry' | 'failed' | 'skipped';
  restaurantId?: string;
  restaurantName?: string;
  rejectionReason?: string;
  error?: string;
}

/**
 * Run one submission end to end.
 *
 * Safe to call concurrently with itself for the same id: the claim is a
 * compare-and-set, and the loser returns `claimed: false` without doing work.
 * Never throws — callers are background tasks and cron batches where one bad
 * submission must not take down the rest.
 */
export async function drainSubmission(
  submissionId: string,
  options: {
    bypassGate?: boolean;
  } = {}
): Promise<DrainOutcome> {
  let attempts = 0;

  // The cron drains serially on purpose and is the mechanism that catches up
  // after a burst, so it must not be turned away by the gate.
  const gated = !options.bypassGate;

  if (gated && activeDrains >= QUEUE_CONFIG.maxConcurrentDrains) {
    console.log(
      `[Worker] ${submissionId} left pending: ${activeDrains} drain(s) already running`
    );
    return { submissionId, claimed: false, status: 'skipped' };
  }
  if (gated) activeDrains++;

  try {
    const record = await getSubmissionById(submissionId);
    if (!record) {
      return { submissionId, claimed: false, status: 'skipped', error: 'No such submission' };
    }
    if (record.status !== 'pending') {
      return { submissionId, claimed: false, status: 'skipped' };
    }

    const claimedAttempts = await claimSubmission(submissionId, record.attempts ?? 0);
    if (claimedAttempts === null) {
      // Another worker claimed it between our read and our write. Correct
      // outcome, not an error — this is exactly what the claim is for.
      return { submissionId, claimed: false, status: 'skipped' };
    }
    attempts = claimedAttempts;

    const result: ProcessingResult = await processSubmission(
      submissionId,
      record.tiktok_url,
      record.user_hint ?? undefined
    );

    if (!result.success) {
      // processSubmission already wrote `rejected` with the reason.
      return {
        submissionId,
        claimed: true,
        status: 'rejected',
        rejectionReason: result.rejectionReason,
      };
    }

    // ── Post-processing ────────────────────────────────
    // The submission is already `completed` and the review is saved, so none
    // of what follows may turn a successful submission into a failed one.
    // Each step is independently recoverable by the recompute cron.
    if (result.restaurantId) {
      try {
        await aggregateRestaurantReviews(result.restaurantId);
      } catch (err: any) {
        console.warn(`[Worker] Aggregate failed for ${result.restaurantId}: ${err.message}`);
      }

      try {
        await syncRestaurantDishes(result.restaurantId);
      } catch (err: any) {
        console.warn(`[Worker] Dish sync failed for ${result.restaurantId}: ${err.message}`);
      }

      try {
        // A new submission is itself a trend signal, so refresh now rather
        // than leaving the restaurant unranked until the next recompute.
        await recomputeRestaurantTrends();
      } catch (err: any) {
        console.warn(`[Worker] Trend recompute failed: ${err.message}`);
      }
    }

    return {
      submissionId,
      claimed: true,
      status: 'completed',
      restaurantId: result.restaurantId,
      restaurantName: result.restaurantName,
    };
  } catch (err: any) {
    const message = err?.message ?? String(err);

    if (attempts === 0) {
      // We never claimed it, so there is nothing to release.
      console.error(`[Worker] ${submissionId} failed before claim: ${message}`);
      return { submissionId, claimed: false, status: 'skipped', error: message };
    }

    const disposition = await releaseSubmission(submissionId, attempts, message);
    console.error(
      `[Worker] ${submissionId} attempt ${attempts} failed (${disposition}): ${message}`
    );
    return { submissionId, claimed: true, status: disposition, error: message };
  } finally {
    if (gated) activeDrains--;
  }
}

/** Drains currently running in this process. For tests and logging. */
export function activeDrainCount(): number {
  return activeDrains;
}
