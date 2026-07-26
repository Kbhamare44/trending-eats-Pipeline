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

export async function findRestaurantByPlaceId(
  placeId: string
): Promise<any | null> {
  const { data, error } = await supabase
    .from('restaurants')
    .select('*')
    .eq('google_place_id', placeId)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Failed to find restaurant: ${error.message}`);
  }

  return data || null;
}

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
      price_level: place.priceLevel,
      cuisine_type: extraction.cuisine,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to create restaurant: ${error.message}`);
  return data.id;
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
      likes: tiktokData.likes,
      views: tiktokData.views,
      dishes_mentioned: extraction.dishesmmentioned,
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