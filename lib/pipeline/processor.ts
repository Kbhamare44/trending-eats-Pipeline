import { fetchTikTokData } from './tiktok';
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
import { syncRestaurantDishes } from '@/lib/dishes/aggregate';
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
    // Mark as processing
    await updateSubmissionStatus(submissionId, 'processing');

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

    // ── Step 8: Link dishes so they are rankable across restaurants ───
    // Failure here must not fail the submission: the restaurant and its
    // review are already saved, and the recompute cron re-syncs dishes.
    try {
      const dishResult = await syncRestaurantDishes(restaurantId);
      console.log(
        `[Pipeline] Linked ${dishResult.dishesLinked} dish(es), ` +
          `${dishResult.mentionsRecorded} mention(s)`
      );
    } catch (dishError: any) {
      console.warn(`[Pipeline] Dish sync failed: ${dishError.message}`);
    }

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
    console.error(`[Pipeline] Failed:`, error.message);
    await updateSubmissionStatus(submissionId, 'failed', {
      errorMessage: error.message,
    });
    return { success: false, error: error.message };
  }
}