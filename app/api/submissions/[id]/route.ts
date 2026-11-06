/**
 * GET /api/submissions/:id — poll the outcome of a submitted link.
 *
 * The app calls this every few seconds while the submit screen is open. It is
 * deliberately cheap: two indexed lookups, no AI, no Places.
 *
 * NOT AUTHENTICATED, on purpose. Submissions may be anonymous, so there is no
 * user to check against — and requiring a token would mean an anonymous
 * submitter could never see what happened to their own link. The id is a v4
 * UUID, so it is unguessable, and the response carries nothing private: the
 * status, the resulting restaurant (already public), or the reason it was
 * turned down. The submitter's identity is never returned.
 */

import type { NextRequest } from 'next/server';
import {
  getSubmissionById,
  getSubmissionOutcome,
  isTerminalStatus,
} from '@/lib/supabase/queries';
import { QUEUE_CONFIG } from '@/lib/config/pipeline';
import { NEEDS_LOCATION } from '@/lib/pipeline/processor';
import { ok, notFound, serverError } from '@/lib/http/respond';

/** Human-readable text for each state, so the app does not build its own. */
function describe(status: string, attempts: number): string {
  switch (status) {
    case 'pending':
      return attempts > 0
        ? 'Still working on it — retrying.'
        : "We're looking into this link.";
    case 'processing':
      return 'Reading the video details now.';
    case 'completed':
      return "Done — it's on the map.";
    case 'rejected':
      return "We couldn't use this one.";
    case 'failed':
      return 'Something went wrong on our side.';
    default:
      return 'Working on it.';
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const record = await getSubmissionById(id);
    if (!record) {
      return notFound('No such submission');
    }

    const done = isTerminalStatus(record.status);
    const outcome =
      record.status === 'completed' ? await getSubmissionOutcome(id) : null;

    return ok({
      submissionId: record.id,
      status: record.status,
      done,
      label: describe(record.status, record.attempts ?? 0),
      restaurantId: outcome?.restaurantId ?? null,
      restaurantName: outcome?.restaurantName ?? null,
      // Rejection is a normal outcome (a recipe video, an unidentifiable
      // restaurant) and the reason is safe to show. An internal error message
      // is not, so it is reported as a state without the detail.
      // Two different outcomes wear the same status: a dead end, and a
      // question the person can answer. The app shows a prompt for the
      // second rather than a flat "couldn't use this one".
      needsLocation: (record.rejection_reason ?? '').startsWith(NEEDS_LOCATION),
      rejectionReason:
        (record.rejection_reason ?? '').replace(NEEDS_LOCATION, '') || null,
      attempts: record.attempts ?? 0,
      maxAttempts: QUEUE_CONFIG.maxAttempts,
      createdAt: record.created_at,
      processedAt: record.processed_at,
      /** Suggested client poll interval, so the app does not hardcode one. */
      pollAfterMs: done ? null : 2500,
    });
  } catch (err) {
    return serverError(err, 'API/submissions/[id]');
  }
}
