import { fetchTikTokData } from './tiktok';
import { fetchTranscript, saveTranscript } from './transcript';
import { classifyContent } from '@/lib/gemini/classify';
import { extractRestaurantData } from '@/lib/gemini/extract';
import { findRestaurant } from '@/lib/google/places';
import {
  updateSubmissionWithTikTokData,
  findReviewByVideoId,
  updateSubmissionStatus,
  findRestaurantByPlaceId,
  createRestaurant,
  createReview,
  upsertCreator,
  refreshRestaurantPlaceData,
} from '@/lib/supabase/queries';
import { isGta } from '@/lib/geo/gta';

/**
 * Marks a rejection the person can resolve by answering, rather than a dead
 * end. Stored in the reason because adding a submission status would mean a
 * migration for one boolean.
 */
export const NEEDS_LOCATION = '[needs-location] ';

export interface ProcessingResult {
  success: boolean;
  restaurantId?: string;
  reviewId?: string;
  restaurantName?: string;
  rejectionReason?: string;
  error?: string;
  /** False when the match is outside the Toronto/GTA launch market. */
  inCoverageArea?: boolean;
  /** True when we need the person to name a city before we can proceed. */
  needsLocation?: boolean;
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

    const savedVideo = tiktokData.videoId ? await findReviewByVideoId(tiktokData.videoId) : null;
    if (savedVideo) {
      await updateSubmissionStatus(submissionId, 'completed');
      return { success: true, restaurantId: savedVideo.restaurantId, restaurantName: savedVideo.restaurantName, isExistingRestaurant: true };
    }

    // ── Step 1b: Transcript ────────────────────────────
    // Runs here, in the background worker, never in the request path.
    // oEmbed can return an embed while omitting a caption visible in TikTok.
    // Try the spoken text before deciding whether we have usable content.
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

    if (!tiktokData.caption.trim() && !transcript.text?.trim()) {
      if (transcript.status === 'failed') {
        // Provider failure is retryable, not evidence about the video.
        throw new Error(`Content retrieval failed: ${transcript.detail ?? 'transcript provider failed'}`);
      }
      const rejectionReason = 'Could not retrieve a caption or spoken transcript for this video';
      await updateSubmissionStatus(submissionId, 'rejected', { rejectionReason });
      return { success: false, rejectionReason };
    }

    // ── Step 2: Classify content ───────────────────────
    console.log(`[Pipeline] Classifying content...`);
    const classification = await classifyContent(
      tiktokData.caption,
      tiktokData.creatorUsername,
      transcript.text ?? undefined
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
      tiktokData.creatorUsername,
      undefined,
      transcript.text ?? undefined
    );

    if (!extraction.restaurantName) {
      await updateSubmissionStatus(submissionId, 'rejected', {
        rejectionReason: 'Could not identify restaurant name from the retrieved caption or transcript',
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

    // A chain with several branches, and the caption never said which city.
    // `city` above was our Toronto default, not evidence, so results[0] is a
    // guess at an address. Say we are unsure instead of inventing a branch.
    // ASK vs REJECT.
    //
    // A missing city in the caption is not evidence of anything. The earlier
    // version compared the result's city against our Toronto DEFAULT and
    // called a mismatch a conflict — which would have rejected Messi
    // Shawarma, where Google knows exactly one business by that name, at a
    // Brampton address. A default we invented cannot contradict a real
    // answer.
    //
    // So we only ask the person to choose when the name genuinely does not
    // identify one place: several results share it and the caption never
    // said which city. A single confident result is the best answer
    // available, wherever it is.
    if (place.ambiguous && !extraction.city) {
      const reason =
        `${NEEDS_LOCATION}"${extraction.restaurantName}" matches more than one ` +
        `location and the video does not say which. Reply with the city or ` +
        `neighbourhood and we will add it.`;
      await updateSubmissionStatus(submissionId, 'rejected', { rejectionReason: reason });
      return { success: false, rejectionReason: reason, needsLocation: true };
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
