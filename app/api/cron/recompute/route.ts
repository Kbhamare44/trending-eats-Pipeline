/**
 * GET /api/cron/recompute — scheduled trend and experience rollup.
 *
 * Reads only our own tables. Rebuilds dish links from stored reviews, scores
 * restaurant and dish momentum from engagement_events, recomputes the
 * experience signal, and snapshots everything to trend_snapshots.
 *
 * Safe to run as often as you like; it is idempotent.
 *
 * SCHEDULING: Vercel's Hobby plan caps crons at one run per day, so vercel.json
 * runs this daily at 10:00 UTC (after /api/cron at 09:00, so freshly accepted
 * submissions are scored in the same cycle). The hourly cadence — which keeps
 * the recency component decaying visibly rather than in jumps — comes from
 * .github/workflows/recompute.yml instead. On Vercel Pro, move the hourly
 * schedule back into vercel.json and delete that workflow.
 */

import type { NextRequest } from 'next/server';
import { recomputeAll } from '@/lib/trends/recompute';
import { isAuthorizedCron } from '@/lib/auth/verify';
import { ok, unauthorized, serverError } from '@/lib/http/respond';

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return unauthorized('Unauthorized');
  }

  try {
    const summary = await recomputeAll();
    console.log('[Cron/recompute]', JSON.stringify(summary));
    return ok(summary);
  } catch (err) {
    return serverError(err, 'API/cron/recompute');
  }
}
