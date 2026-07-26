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
} from '@/lib/supabase/queries';

export interface ProcessingResult {
  success: boolean;
  restaurantId?: string;
  reviewId?: string;
  rejectionReason?: string;
  error?: string;
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

    if (existing) {
      restaurantId = existing.id;
      console.log(`[Pipeline] Found existing restaurant: ${existing.name}`);
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

    // ── Mark complete ──────────────────────────────────
    await updateSubmissionStatus(submissionId, 'completed');

    console.log(`[Pipeline] Completed: restaurant=${restaurantId}, review=${reviewId}`);

    return { success: true, restaurantId, reviewId };

  } catch (error: any) {
    console.error(`[Pipeline] Failed:`, error.message);
    await updateSubmissionStatus(submissionId, 'failed', {
      errorMessage: error.message,
    });
    return { success: false, error: error.message };
  }
}