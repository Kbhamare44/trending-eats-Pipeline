import { fetchTikTokData } from './tiktok';
import { fetchTranscript, saveTranscript } from './transcript';
import { classifyContent } from '@/lib/gemini/classify';
import { extractRestaurantData } from '@/lib/gemini/extract';
import { findRestaurant } from '@/lib/google/places';
import {
  updateSubmissionWithTikTokData,
  updateSubmissionStatus,
  findRestaurantByPlaceId,
  createRestaurant,
  createReview,
  upsertCreator,
  refreshRestaurantPlaceData,
} from '@/lib/supabase/queries';
import { isGta } from '@/lib/geo/gta';

export interface ProcessingResult {
  success: boolean;
  restaurantId?: string;
  reviewId?: string;
  restaurantName?: string;
  rejectionReason?: string;
  error?: string;
  /** False when the match is outside the Toronto/GTA launch market. */
  inCoverageArea?: boolean;
  /** Set when the restaurant was already in our database. */
  isExistingRestaurant?: boolean;
}

export async function processSubmission(
  submissionId: string,
  tiktokUrl: string
): Promise<ProcessingResult> {
  console.log(`[Pipeline] Starting: ${submissionId}`);

  try {
    // NOTE: the row is already marked `processing` by claimSubmission() in
    // lib/pipeline/worker.ts. Setting it here as well would be harmless but
    // misleading — the claim is what makes it exclusive, not this write.

    // ── Step 1: Fetch TikTok data ──────────────────────
    console.log(`[Pipeline] Fetching TikTok data...`);
    const tiktokData = await fetchTikTokData(tiktokUrl);
    await updateSubmissionWithTikTokData(submissionId, tiktokData);

    if (!tiktokData.caption) {
      await updateSubmissionStatus(submissionId, 'rejected', {
        rejectionReason: 'No caption available to process',
      });
      return { success: false, rejectionReason: 'No caption' };
    }

    // ── Step 1b: Transcript ────────────────────────────
    // Runs here, in the background worker, never in the request path.
    //
    // NOT YET PASSED TO THE PROMPTS. Combining caption and transcript changes
    // what Gemini is asked, and a prompt change is reviewed before it ships,
    // so this pass fetches and stores transcripts only. Storing them first is
    // also what makes the comparison possible: scripts/measure-transcript.ts
    // replays stored transcripts against caption-only extraction to find out
    // whether the transcript is worth its cost per submission.
    //
    // A transcript never fails a submission — fetchTranscript resolves to a
    // status instead of throwing, and nothing below branches on it.
    const transcript = await fetchTranscript(tiktokUrl, {
      videoId: tiktokData.videoId || null,
      captionLength: tiktokData.caption.length,
    });
    await saveTranscript(submissionId, transcript);
    if (transcript.status !== 'not_attempted') {
      console.log(
        `[Pipeline] transcript ${transcript.status}` +
          (transcript.source ? ` via ${transcript.source}` : '') +
          (transcript.text ? ` (${transcript.text.length} chars)` : '') +
          (transcript.detail ? ` — ${transcript.detail}` : '')
      );
    }

    // ── Step 2: Classify content ───────────────────────
    console.log(`[Pipeline] Classifying content...`);
    const classification = await classifyContent(
      tiktokData.caption,
      tiktokData.creatorUsername
    );

    if (!classification.isRestaurantReview || classification.confidence < 0.4) {
      await updateSubmissionStatus(submissionId, 'rejected', {
        rejectionReason: `Not a restaurant review (${classification.contentType}, confidence: ${classification.confidence})`,
      });
      return {
        success: false,
        rejectionReason: `Not a restaurant review: ${classification.contentType} — ${classification.reasoning}`,
      };
    }

    // ── Step 3: Extract restaurant details ─────────────
    console.log(`[Pipeline] Extracting restaurant data...`);
    const extraction = await extractRestaurantData(
      tiktokData.caption,
      tiktokData.creatorUsername
    );

    if (!extraction.restaurantName) {
      await updateSubmissionStatus(submissionId, 'rejected', {
        rejectionReason: 'Could not identify restaurant name from caption',
      });
      return { success: false, rejectionReason: 'No restaurant name found' };
    }

    // Reject high-confidence sponsored content
    if (extraction.isSponsored && extraction.sponsorshipConfidence > 0.85) {
      await updateSubmissionStatus(submissionId, 'rejected', {
        rejectionReason: `High-confidence sponsored content (${Math.round(extraction.sponsorshipConfidence * 100)}%)`,
      });
      return { success: false, rejectionReason: 'Sponsored content rejected' };
    }

    // ── Step 4: Verify with Google Places ─────────────
    console.log(`[Pipeline] Verifying with Google Places...`);
    // GTA-first: when the caption gives no location, search Toronto. This is
    // a launch-market assumption, not a fact about the video — if the match
    // lands outside the GTA we flag it rather than pretend it is local.
    const city = extraction.city || 'Toronto';
    const place = await findRestaurant(extraction.restaurantName, city);

    if (!place) {
      await updateSubmissionStatus(submissionId, 'rejected', {
        rejectionReason: `Restaurant "${extraction.restaurantName}" not found on Google Places`,
      });
      return { success: false, rejectionReason: 'Restaurant not found on Google Places' };
    }

    // ── Step 5: Get or create restaurant ──────────────
    console.log(`[Pipeline] Saving to database...`);
    let restaurantId: string;
    const existing = await findRestaurantByPlaceId(place.placeId);

    let isExistingRestaurant = false;

    if (existing) {
      restaurantId = existing.id;
      isExistingRestaurant = true;
      console.log(`[Pipeline] Found existing restaurant: ${existing.name}`);
      // We just paid for a fresh Places lookup, so write it through. Places
      // terms limit how long most fields may be retained, and a months-old
      // cached rating should not keep being displayed.
      await refreshRestaurantPlaceData(restaurantId, place);
    } else {
      restaurantId = await createRestaurant(place, extraction);
      console.log(`[Pipeline] Created new restaurant: ${place.name}`);
    }

    // ── Step 6: Create review ──────────────────────────
    const reviewId = await createReview(
      restaurantId,
      submissionId,
      tiktokData,
      extraction
    );

    // ── Step 7: Update creator stats ──────────────────
    if (tiktokData.creatorUsername) {
      await upsertCreator(tiktokData.creatorUsername, extraction.isSponsored);
    }

    // Dish linking, review aggregation and the trend refresh all happen in
    // lib/pipeline/worker.ts once this returns. They used to run here too,
    // which meant every submission did the dish sync twice.

    // ── Mark complete ──────────────────────────────────
    await updateSubmissionStatus(submissionId, 'completed');

    const inCoverageArea = isGta(place.city, place.address);
    if (!inCoverageArea) {
      console.log(
        `[Pipeline] ${place.name} is in ${place.city}, outside the GTA launch market`
      );
    }

    console.log(`[Pipeline] Completed: restaurant=${restaurantId}, review=${reviewId}`);

    return {
      success: true,
      restaurantId,
      reviewId,
      restaurantName: place.name,
      inCoverageArea,
      isExistingRestaurant,
    };

  } catch (error: any) {
    // Deliberately NOT marked `failed` here. A Gemini 503 or a Places rate
    // limit is transient, and writing a terminal status would retire the
    // submission on its first bad minute. The worker owns that decision: it
    // knows the attempt count and either requeues or gives up.
    console.error(`[Pipeline] Failed:`, error.message);
    throw error;
  }
}