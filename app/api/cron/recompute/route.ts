/**
 * GET /api/cron/recompute — scheduled trend and experience rollup.
 *
 * Reads only our own tables. Rebuilds dish links from stored reviews, scores
 * restaurant and dish momentum from engagement_events, recomputes the
 * experience signal, and snapshots everything to trend_snapshots.
 *
 * Safe to run as often as you like; it is idempotent. Scheduled hourly in
 * vercel.json so the recency component decays visibly rather than in jumps.
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
