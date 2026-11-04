/**
 * GET /api/cron — scheduled submission processing.
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
 */

import type { NextRequest } from 'next/server';
import { getPendingSubmissions } from '@/lib/supabase/queries';
import { processSubmission } from '@/lib/pipeline/processor';
import { aggregateRestaurantReviews } from '@/lib/pipeline/aggregator';
import { syncRestaurantDishes } from '@/lib/dishes/aggregate';
import { isAuthorizedCron } from '@/lib/auth/verify';
import { ok, unauthorized, serverError } from '@/lib/http/respond';

/** Gemini + Places + oEmbed per submission; give it room. */
export const maxDuration = 300;

const BATCH_SIZE = 5;

export async function GET(request: NextRequest) {
  // Accepts CRON_SECRET (what Vercel Cron actually sends) or PIPELINE_SECRET.
  // The previous version only accepted PIPELINE_SECRET, so if those two env
  // vars ever differed this job was silently 401ing on every run.
  if (!isAuthorizedCron(request)) {
    return unauthorized('Unauthorized');
  }

  try {
    const pending = await getPendingSubmissions(BATCH_SIZE);
    console.log(`[Cron] Processing ${pending.length} user-submitted links`);

    const outcomes = await Promise.allSettled(
      pending.map(async (submission: any) => {
        const result = await processSubmission(
          submission.id,
          submission.tiktok_url
        );

        if (result.success && result.restaurantId) {
          await aggregateRestaurantReviews(result.restaurantId);
          await syncRestaurantDishes(result.restaurantId);
        }

        return result;
      })
    );

    // The old version counted a rejected submission as a "failure", which
    // conflated "the pipeline broke" with "that video was not a restaurant
    // review" — a normal, expected outcome.
    let accepted = 0;
    let rejected = 0;
    let errored = 0;

    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        errored++;
      } else if (outcome.value.success) {
        accepted++;
      } else if (outcome.value.rejectionReason) {
        rejected++;
      } else {
        errored++;
      }
    }

    return ok({
      processed: pending.length,
      accepted,
      rejected,
      errored,
      note: 'Processes user-submitted links only. No autonomous collection.',
    });
  } catch (err) {
    return serverError(err, 'API/cron');
  }
}
