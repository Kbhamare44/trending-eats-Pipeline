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
 * Change from the previous version: `userId` is no longer read from the body.
 * It was unverified, so any caller could attribute submissions to any user —
 * which also fed the creator and trend stats. It now comes from the bearer
 * token, and anonymous submissions are allowed with a null submitter.
 */

import type { NextRequest } from 'next/server';
import { createRawSubmission } from '@/lib/supabase/queries';
import { processSubmission } from '@/lib/pipeline/processor';
import { aggregateRestaurantReviews } from '@/lib/pipeline/aggregator';
import { recomputeRestaurantTrends } from '@/lib/trends/recompute';
import { getAuthedUser } from '@/lib/auth/verify';
import { ok, badRequest, serverError } from '@/lib/http/respond';

/** oEmbed + two Gemini calls + two Places calls. */
export const maxDuration = 120;

function looksLikeTikTokUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      /(^|\.)tiktok\.com$/.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

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
    if (!looksLikeTikTokUrl(url)) {
      return badRequest('That does not look like a TikTok link');
    }

    const user = await getAuthedUser(request);

    const submissionId = await createRawSubmission(url, user?.id ?? null);
    const result = await processSubmission(submissionId, url);

    if (result.success && result.restaurantId) {
      await aggregateRestaurantReviews(result.restaurantId);

      // A new submission is itself a trend signal, so refresh scores now
      // rather than making the user wait for the scheduled recompute.
      try {
        await recomputeRestaurantTrends();
      } catch (trendError: any) {
        console.warn('[Submit] trend recompute failed:', trendError.message);
      }
    }

    return ok({ submissionId, ...result });
  } catch (err) {
    return serverError(err, 'API/submit');
  }
}
