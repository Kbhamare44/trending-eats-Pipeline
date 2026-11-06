import { fetchTikTokData } from './tiktok';
import { fetchTranscript, saveTranscript } from './transcript';
import { fetchCaption } from './caption';
import { extractNameCandidates, cityClue } from './nameCandidates';
import type { SubmissionHint, SubmissionResolution } from '@/lib/types';
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

/**
 * Marks a rejection the person can fix by naming the place.
 *
 * Used when retrieved inputs do not identify the subject. Missing API
 * metadata is not evidence that the video has no visible caption.
 */
export const NEEDS_NAME = '[needs-name] ';

export interface ProcessingResult {
  success: boolean;
  restaurantId?: string;
  reviewId?: string;
  restaurantName?: string;
  rejectionReason?: string;
  error?: string;
  /** False when the match is outside the Toronto/GTA launch market. */
  inCoverageArea?: boolean;
  /** True when we could not identify the restaurant and must ask. */
  needsName?: boolean;
  /** True when we need the person to name a city before we can proceed. */
  needsLocation?: boolean;
  /** Set when the restaurant was already in our database. */
  isExistingRestaurant?: boolean;
}

export async function processSubmission(
  submissionId: string,
  tiktokUrl: string,
  /** Loaded by the worker from the queue row, including after a restart. */
  hint?: SubmissionHint
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

    // Dedupe again, now that we know the REAL video id.
    //
    // /api/submit already checks, but a share link from the TikTok app looks
    // like vt.tiktok.com/ZSpjuYYF7 and extractVideoId can only return that
    // short code without following the redirect. The reviews table stores
    // the numeric id, so the check at the door misses every short link —
    // which is why 36 submissions exist for 11 videos. oEmbed has just
    // resolved it, so this costs one indexed lookup and saves a Supadata
    // credit, two Gemini calls and two Places calls per repeat.
    if (tiktokData.videoId) {
      const seen = await findReviewByVideoId(tiktokData.videoId);
      if (seen) {
        await updateSubmissionStatus(submissionId, 'completed');
        console.log(`[Pipeline] Already have ${tiktokData.videoId} — skipping analysis`);
        return {
          success: true,
          restaurantId: seen.restaurantId,
          restaurantName: seen.restaurantName,
          isExistingRestaurant: true,
          inCoverageArea: true,
        };
      }
    }

    if (!tiktokData.caption.trim()) {
      const caption = await fetchCaption(submissionId, tiktokData.videoId, tiktokData.url);
      if (caption.text) tiktokData.caption = caption.text;
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

    const captionCandidates = extractNameCandidates(tiktokData.caption, 'caption');
    const speechCandidates = extractNameCandidates(transcript.text ?? '', 'transcript');
    const evidence = captionCandidates[0] ?? extraction.restaurantNameEvidence ?? speechCandidates[0];
    const resolution: SubmissionResolution = {
      restaurantName: extraction.restaurantName,
      ...(evidence ? { nameSource: { source: evidence.source, sourcePhrase: evidence.sourcePhrase } } : {}),
    };
    // Keep a usable caption name even if the speech/model names a comparison.
    if (hint?.restaurantName) {
      extraction.restaurantName = hint.restaurantName;
      resolution.nameSource = {source: 'user', sourcePhrase: hint.restaurantName};
    } else if (captionCandidates[0]) extraction.restaurantName = captionCandidates[0].name;
    else if (!extraction.restaurantNameEvidence) extraction.restaurantName = speechCandidates[0]?.name ?? null;
    resolution.restaurantName = extraction.restaurantName;

    if (!extraction.restaurantName) {
      await updateSubmissionStatus(submissionId, 'rejected', {
        rejectionReason:
          NEEDS_NAME +
          'We could not work out which restaurant this is. What is it called?',
        resolution,
      });
      return {
        success: false,
        rejectionReason: 'We could not work out which restaurant this is. What is it called?',
        needsName: true,
      };
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
    const clue = cityClue(tiktokData.caption, transcript.text ?? '', extraction.city, resolution.nameSource?.sourcePhrase);
    const city = hint?.city?.trim() || clue.city;
    extraction.city = city || null;
    const place = await findRestaurant(extraction.restaurantName, city, hint?.placeId);

    if (!place) {
      await updateSubmissionStatus(submissionId, 'rejected', {
        rejectionReason: `${NEEDS_LOCATION}We detected "${extraction.restaurantName}" but could not verify its location. Check the name and add a city.`,
        resolution,
      });
      return { success: false, rejectionReason: 'Name detected; location not confirmed', needsLocation: true };
    }

    if ((!city && !hint?.placeId) || place.locationVerified !== true || place.ambiguous || (clue.conflict && !hint?.city && !hint?.placeId)) {
      const reason =
        `${NEEDS_LOCATION}We detected "${extraction.restaurantName}" but need to confirm its city or branch. Choose a location below, or correct the name and city.`;
      resolution.candidates = place.candidates ?? [];
      await updateSubmissionStatus(submissionId, 'rejected', { rejectionReason: reason, resolution });
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
    await updateSubmissionStatus(submissionId, 'completed', { resolution });

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
