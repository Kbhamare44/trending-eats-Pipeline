import { supabase } from './client';
import { TikTokData, ExtractionResult, PlaceResult } from '@/lib/types';

// ── Raw Submissions ──────────────────────────────────────

export async function createRawSubmission(
  tiktokUrl: string,
  submittedBy: string | null
): Promise<string> {
  const { data, error } = await supabase
    .from('raw_submissions')
    .insert({
      tiktok_url: tiktokUrl,
      submitted_by: submittedBy,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to create submission: ${error.message}`);
  return data.id;
}

export async function updateSubmissionWithTikTokData(
  submissionId: string,
  data: TikTokData
): Promise<void> {
  const { error } = await supabase
    .from('raw_submissions')
    .update({
      tiktok_video_id: data.videoId,
      caption: data.caption,
      creator_username: data.creatorUsername,
      thumbnail_url: data.thumbnailUrl,
      embed_html: data.embedHtml,
      likes: data.likes,
      views: data.views,
    })
    .eq('id', submissionId);

  if (error) throw new Error(`Failed to update submission: ${error.message}`);
}

export async function updateSubmissionStatus(
  submissionId: string,
  status: string,
  extra?: { errorMessage?: string; rejectionReason?: string }
): Promise<void> {
  const { error } = await supabase
    .from('raw_submissions')
    .update({
      status,
      processed_at: new Date().toISOString(),
      error_message: extra?.errorMessage || null,
      rejection_reason: extra?.rejectionReason || null,
    })
    .eq('id', submissionId);

  if (error) throw new Error(`Failed to update status: ${error.message}`);
}

export async function getPendingSubmissions(
  limit: number = 10
): Promise<any[]> {
  const { data, error } = await supabase
    .from('raw_submissions')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Failed to fetch pending: ${error.message}`);
  return data || [];
}

// ── Restaurants ──────────────────────────────────────────

/**
 * Find a restaurant by its Google place id.
 *
 * Ordered + limit(1) + maybeSingle rather than single(). `single()` raises
 * not only when there are no rows (PGRST116, which was handled) but also when
 * there is MORE than one — and that case was not handled, so a single
 * duplicate row would make every future submission for that restaurant throw,
 * permanently, with an error that reads like a database fault rather than a
 * data problem.
 *
 * Ordering by created_at makes the choice deterministic: if duplicates do
 * exist, every caller converges on the same oldest row instead of attaching
 * reviews to whichever one the planner happened to return.
 */
export async function findRestaurantByPlaceId(
  placeId: string
): Promise<any | null> {
  const { data, error } = await supabase
    .from('restaurants')
    .select('*')
    .eq('google_place_id', placeId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to find restaurant: ${error.message}`);
  }

  return data || null;
}

/**
 * Create a restaurant, tolerating a concurrent create of the same one.
 *
 * THE RACE: processSubmission looks the restaurant up by google_place_id and
 * inserts if absent. Two submissions for the same restaurant processed at the
 * same time — which is exactly what a seeding run with several videos of one
 * viral bakery produces — both miss the lookup and both insert.
 *
 * What happens next depends on a constraint this repo does not define (the
 * base schema was created elsewhere). If google_place_id is unique, one
 * insert fails and, before this change, took the whole submission down with
 * it: the worker would mark it for retry, and the retry would re-run the
 * Gemini and Places calls that had already succeeded. If it is NOT unique,
 * the far worse outcome — two restaurant rows for one business, splitting its
 * reviews, its trend score and its map pin, and breaking
 * findRestaurantByPlaceId, which uses .single().
 *
 * So this re-reads by place id on any insert failure and uses whatever is
 * there. Correct under either constraint, and it costs one extra query only
 * on the rare collision.
 */
export async function createRestaurant(
  place: PlaceResult,
  extraction: ExtractionResult
): Promise<string> {
  const { data, error } = await supabase
    .from('restaurants')
    .insert({
      google_place_id: place.placeId,
      name: place.name,
      address: place.address,
      city: place.city,
      latitude: place.latitude,
      longitude: place.longitude,
      phone: place.phone,
      website: place.website,
      google_rating: place.googleRating,
      google_rating_count: place.googleRatingCount ?? null,
      google_data_refreshed_at: place.fetchedAt ?? new Date().toISOString(),
      price_level: place.priceLevel,
      cuisine_type: extraction.cuisine,
      // is_gta and region are set by the te_restaurant_geography trigger.
    })
    .select('id')
    .single();

  if (error) {
    const existing = await findRestaurantByPlaceId(place.placeId);
    if (existing?.id) {
      console.log(
        `[Queries] lost a create race for ${place.name}; using the existing row`
      );
      return existing.id;
    }
    throw new Error(`Failed to create restaurant: ${error.message}`);
  }
  return data.id;
}

/**
 * Refresh the Google-sourced fields on an existing restaurant.
 *
 * Places terms do not allow retaining most fields indefinitely, so a
 * restaurant we saw months ago should have its rating re-pulled rather than
 * displayed from a stale cache.
 */
export async function refreshRestaurantPlaceData(
  restaurantId: string,
  place: PlaceResult
): Promise<void> {
  const { error } = await supabase
    .from('restaurants')
    .update({
      address: place.address,
      city: place.city,
      latitude: place.latitude,
      longitude: place.longitude,
      phone: place.phone,
      website: place.website,
      google_rating: place.googleRating,
      google_rating_count: place.googleRatingCount ?? null,
      google_data_refreshed_at: place.fetchedAt ?? new Date().toISOString(),
      price_level: place.priceLevel,
      updated_at: new Date().toISOString(),
    })
    .eq('id', restaurantId);

  if (error) {
    console.warn(`[Queries] Place refresh failed for ${restaurantId}: ${error.message}`);
  }
}

// ── Reviews ──────────────────────────────────────────────

export async function createReview(
  restaurantId: string,
  submissionId: string,
  tiktokData: TikTokData,
  extraction: ExtractionResult
): Promise<string> {
  // Reduce authenticity weight for sponsored content
  const authenticityWeight = extraction.isSponsored
    ? Math.max(0, 1 - extraction.sponsorshipConfidence)
    : 1.0;

  const { data, error } = await supabase
    .from('reviews')
    .insert({
      restaurant_id: restaurantId,
      submission_id: submissionId,
      tiktok_url: tiktokData.url,
      tiktok_video_id: tiktokData.videoId,
      creator_username: tiktokData.creatorUsername,
      thumbnail_url: tiktokData.thumbnailUrl,
      embed_html: tiktokData.embedHtml,
      likes: tiktokData.likes,
      views: tiktokData.views,
      dishes_mentioned: extraction.dishesMentioned,
      sentiment: extraction.sentiment,
      sentiment_score: extraction.sentimentScore,
      pros: extraction.pros,
      cons: extraction.cons,
      atmosphere: extraction.atmosphere,
      price_range: extraction.priceRange,
      good_for: extraction.goodFor,
      reviewer_summary: extraction.reviewerSummary,
      is_sponsored: extraction.isSponsored,
      sponsorship_confidence: extraction.sponsorshipConfidence,
      sponsorship_signals: extraction.sponsorshipSignals,
      authenticity_weight: authenticityWeight,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to create review: ${error.message}`);
  return data.id;
}

export async function getReviewsByRestaurant(
  restaurantId: string
): Promise<any[]> {
  const { data, error } = await supabase
    .from('reviews')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Failed to get reviews: ${error.message}`);
  return data || [];
}

// ── Creators ─────────────────────────────────────────────

export async function upsertCreator(
  username: string,
  isSponsored: boolean
): Promise<void> {
  const { data: existing } = await supabase
    .from('creators')
    .select('*')
    .eq('username', username)
    .single();

  if (existing) {
    const newReviewCount = existing.review_count + 1;
    const newSponsoredCount = existing.sponsored_count + (isSponsored ? 1 : 0);
    const sponsoredRatio = newSponsoredCount / newReviewCount;
    // Credibility drops as sponsored ratio increases
    const credibilityScore = Math.max(0, 1 - sponsoredRatio * 0.5);

    await supabase
      .from('creators')
      .update({
        review_count: newReviewCount,
        sponsored_count: newSponsoredCount,
        credibility_score: credibilityScore,
        last_seen: new Date().toISOString(),
      })
      .eq('username', username);
  } else {
    await supabase.from('creators').insert({
      username,
      review_count: 1,
      sponsored_count: isSponsored ? 1 : 0,
      credibility_score: isSponsored ? 0.5 : 1.0,
    });
  }
}
// ── Submission queue ─────────────────────────────────────
//
// These back the async submission pipeline. /api/submit no longer processes a
// link in the request path; it enqueues a row and returns, and the work is
// done by a background worker (next/server `after`) with the cron as the
// safety net. That means two workers can race for the same row, so claiming
// has to be atomic — see claimSubmission.

import { QUEUE_CONFIG, isTerminalStatus } from '@/lib/config/pipeline';

export { isTerminalStatus };

export interface SubmissionRecord {
  id: string;
  status: string;
  tiktok_url: string;
  tiktok_video_id: string | null;
  attempts: number;
  rejection_reason: string | null;
  error_message: string | null;
  created_at: string;
  processed_at: string | null;
}

export async function getSubmissionById(
  submissionId: string
): Promise<SubmissionRecord | null> {
  const { data, error } = await supabase
    .from('raw_submissions')
    .select(
      'id, status, tiktok_url, tiktok_video_id, attempts, rejection_reason, error_message, created_at, processed_at'
    )
    .eq('id', submissionId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load submission: ${error.message}`);
  return (data as SubmissionRecord | null) ?? null;
}

/**
 * The restaurant a completed submission produced, resolved through the review
 * it created. `reviews.submission_id` is the only link between the two.
 */
export async function getSubmissionOutcome(
  submissionId: string
): Promise<{ restaurantId: string; restaurantName: string } | null> {
  const { data, error } = await supabase
    .from('reviews')
    .select('restaurant_id, restaurants(name)')
    .eq('submission_id', submissionId)
    .maybeSingle();

  if (error || !data?.restaurant_id) return null;

  const joined = (data as any).restaurants;
  const name = Array.isArray(joined) ? joined[0]?.name : joined?.name;
  return { restaurantId: data.restaurant_id as string, restaurantName: name ?? '' };
}

/**
 * Has this exact video already produced a review? Used by /api/submit to
 * answer a duplicate submission immediately instead of paying for the whole
 * pipeline to rediscover it.
 */
export async function findReviewByVideoId(
  videoId: string
): Promise<{ restaurantId: string; restaurantName: string } | null> {
  const { data, error } = await supabase
    .from('reviews')
    .select('restaurant_id, restaurants(name)')
    .eq('tiktok_video_id', videoId)
    .limit(1)
    .maybeSingle();

  if (error || !data?.restaurant_id) return null;

  const joined = (data as any).restaurants;
  const name = Array.isArray(joined) ? joined[0]?.name : joined?.name;
  return { restaurantId: data.restaurant_id as string, restaurantName: name ?? '' };
}

/**
 * An in-flight submission for the same URL, so double-tapping Submit returns
 * the first submission's id rather than queueing the same work twice.
 */
export async function findOpenSubmissionByUrl(
  tiktokUrl: string
): Promise<SubmissionRecord | null> {
  const { data, error } = await supabase
    .from('raw_submissions')
    .select(
      'id, status, tiktok_url, tiktok_video_id, attempts, rejection_reason, error_message, created_at, processed_at'
    )
    .eq('tiktok_url', tiktokUrl)
    .in('status', ['pending', 'processing'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return null;
  return (data as SubmissionRecord | null) ?? null;
}

/**
 * Atomically take ownership of a pending submission.
 *
 * The `.eq('status', 'pending')` in the UPDATE is the whole point: it makes
 * the claim a compare-and-set. Two workers running at once both issue this
 * statement, Postgres serialises them, and only the first sees a row come
 * back. Checking the status with a SELECT and then updating would let both
 * through and run the pipeline — and bill Gemini and Places — twice.
 *
 * Returns the new attempt number, or null if somebody else got there first.
 */
export async function claimSubmission(
  submissionId: string,
  currentAttempts: number
): Promise<number | null> {
  const nextAttempts = currentAttempts + 1;

  const { data, error } = await supabase
    .from('raw_submissions')
    .update({ status: 'processing', attempts: nextAttempts })
    .eq('id', submissionId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  if (error) throw new Error(`Failed to claim submission: ${error.message}`);
  return data ? nextAttempts : null;
}

/**
 * A claimed submission hit a transient error. Put it back in the queue, or
 * give up if it has used all its attempts.
 */
export async function releaseSubmission(
  submissionId: string,
  attempts: number,
  errorMessage: string
): Promise<'retry' | 'failed'> {
  const exhausted = attempts >= QUEUE_CONFIG.maxAttempts;

  const { error } = await supabase
    .from('raw_submissions')
    .update({
      status: exhausted ? 'failed' : 'pending',
      error_message: errorMessage.slice(0, 500),
      ...(exhausted ? { processed_at: new Date().toISOString() } : {}),
    })
    .eq('id', submissionId);

  if (error) {
    console.error(`[Queue] Could not release ${submissionId}: ${error.message}`);
  }

  return exhausted ? 'failed' : 'retry';
}

/**
 * Rescue rows abandoned mid-processing.
 *
 * A worker that is killed by the platform timeout leaves its row in
 * `processing` forever: the cron only looks for `pending`, so nothing retries
 * it and the user's submission silently never appears. Rows past their
 * attempt budget go straight to `failed` instead of looping.
 */
export async function requeueStuckSubmissions(): Promise<{
  requeued: number;
  failed: number;
}> {
  const cutoff = new Date(
    Date.now() - QUEUE_CONFIG.stuckAfterMinutes * 60_000
  ).toISOString();

  const { data: stuck, error } = await supabase
    .from('raw_submissions')
    .select('id, attempts')
    .eq('status', 'processing')
    .lt('created_at', cutoff);

  if (error) throw new Error(`Failed to scan for stuck rows: ${error.message}`);
  if (!stuck?.length) return { requeued: 0, failed: 0 };

  const toRequeue = stuck.filter((r: any) => r.attempts < QUEUE_CONFIG.maxAttempts);
  const toFail = stuck.filter((r: any) => r.attempts >= QUEUE_CONFIG.maxAttempts);

  if (toRequeue.length) {
    await supabase
      .from('raw_submissions')
      .update({ status: 'pending' })
      .in('id', toRequeue.map((r: any) => r.id));
  }

  if (toFail.length) {
    await supabase
      .from('raw_submissions')
      .update({
        status: 'failed',
        error_message: `Gave up after ${QUEUE_CONFIG.maxAttempts} attempts`,
        processed_at: new Date().toISOString(),
      })
      .in('id', toFail.map((r: any) => r.id));
  }

  return { requeued: toRequeue.length, failed: toFail.length };
}

/**
 * How many submissions a caller has made in the last hour.
 *
 * Counted against `raw_submissions` because that table already records every
 * submission with a timestamp — no new table, and the count is durable across
 * cold starts, which an in-memory limiter is not. Spend is proportional to
 * rows here, so this bounds spend directly.
 *
 * Pass null for anonymous, which counts ALL anonymous submissions in the
 * window as one shared budget: anonymous callers cannot be told apart, and
 * giving each one its own allowance would be no limit at all.
 */
export async function countRecentSubmissions(
  userId: string | null,
  windowMs: number
): Promise<number> {
  const since = new Date(Date.now() - windowMs).toISOString();

  let query = supabase
    .from('raw_submissions')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since);

  query = userId ? query.eq('submitted_by', userId) : query.is('submitted_by', null);

  const { count, error } = await query;

  if (error) {
    // Fail OPEN, deliberately. A broken count must not stop real people
    // submitting; the queue's own attempt limits and the provider quotas are
    // the backstop. Logged loudly so it does not pass unnoticed.
    console.error('[RateLimit] submission count failed, allowing:', error.message);
    return 0;
  }
  return count ?? 0;
}
