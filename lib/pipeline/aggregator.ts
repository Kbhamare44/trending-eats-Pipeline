import { supabase } from '@/lib/supabase/client';
// Old:
// import { openai } from '@/lib/openai/client';

// New:
import { generateText, MODELS } from '@/lib/gemini/client';
import { getReviewsByRestaurant } from '@/lib/supabase/queries';

// Only regenerate summary if there are enough new reviews
const MIN_REVIEWS_FOR_SUMMARY = 2;
const REGENERATE_EVERY_N_REVIEWS = 3;

export async function aggregateRestaurantReviews(
  restaurantId: string
): Promise<void> {
  const reviews = await getReviewsByRestaurant(restaurantId);

  if (reviews.length < MIN_REVIEWS_FOR_SUMMARY) {
    console.log(`[Aggregator] Not enough reviews for ${restaurantId} (${reviews.length})`);
    return;
  }

  // Only regenerate every N reviews to save API costs
  if (reviews.length % REGENERATE_EVERY_N_REVIEWS !== 0) {
    console.log(`[Aggregator] Skipping regeneration (${reviews.length} reviews)`);
    // Still update the basic stats
    await updateBasicStats(restaurantId, reviews);
    return;
  }

  console.log(`[Aggregator] Generating summary for ${restaurantId} (${reviews.length} reviews)`);

  // Calculate authenticity score
  const authenticReviews = reviews.filter((r) => !r.is_sponsored);
  const avgAuthenticityWeight =
    reviews.reduce((sum: number, r: any) => sum + (r.authenticity_weight || 1), 0) /
    reviews.length;

  const authenticityScore = Math.min(
    1,
    (authenticReviews.length / reviews.length) * avgAuthenticityWeight
  );

  // Calculate average sentiment
  const avgSentiment =
    reviews.reduce((sum: number, r: any) => sum + (r.sentiment_score || 0), 0) /
    reviews.length;

  // Count dish mentions
  const dishCounts: Record<string, number> = {};
  reviews.forEach((review: any) => {
    const dishes = review.dishes_mentioned || [];
    dishes.forEach((dish: string) => {
      const normalized = dish.toLowerCase().trim();
      dishCounts[normalized] = (dishCounts[normalized] || 0) + 1;
    });
  });

  const topDishes = Object.entries(dishCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([dish, count]) => ({ dish, mentions: count }));

  // Collect all pros and cons
  const allPros = reviews.flatMap((r: any) => r.pros || []);
  const allCons = reviews.flatMap((r: any) => r.cons || []);

  // Generate AI summary using all review summaries
  const reviewSummaries = reviews
    .slice(0, 10) // Cap at 10 for token efficiency
    .map((r: any) => r.reviewer_summary)
    .filter(Boolean)
    .join('\n- ');

  const aiSummary = await generateRestaurantSummary({
    reviewCount: reviews.length,
    authenticReviewCount: authenticReviews.length,
    avgSentiment,
    topDishes,
    allPros,
    allCons,
    reviewSummaries,
    authenticityScore,
  });

  // Update restaurant with aggregated data
  await supabase
    .from('restaurants')
    .update({
      ai_summary: aiSummary,
      authenticity_score: authenticityScore,
      review_count: reviews.length,
      avg_sentiment: avgSentiment,
      top_dishes: topDishes,
      common_pros: deduplicateAndCount(allPros).slice(0, 5),
      common_cons: deduplicateAndCount(allCons).slice(0, 5),
      updated_at: new Date().toISOString(),
    })
    .eq('id', restaurantId);

  console.log(`[Aggregator] Summary updated for ${restaurantId}`);
}

async function generateRestaurantSummary(data: {
  reviewCount: number;
  authenticReviewCount: number;
  avgSentiment: number;
  topDishes: any[];
  allPros: string[];
  allCons: string[];
  reviewSummaries: string;
  authenticityScore: number;
}): Promise<string> {
  const sentimentLabel =
    data.avgSentiment > 0.3 ? 'positive' :
    data.avgSentiment < -0.3 ? 'negative' : 'mixed';

  const prompt = `You are writing a restaurant summary for a food discovery app.

Data from ${data.reviewCount} TikTok reviews (${data.authenticReviewCount} appear authentic):
- Overall sentiment: ${sentimentLabel} (score: ${data.avgSentiment.toFixed(2)})
- Authenticity score: ${(data.authenticityScore * 100).toFixed(0)}%
- Top dishes: ${data.topDishes.map(d => `${d.dish} (${d.mentions}x)`).join(', ')}
- Common pros: ${data.allPros.slice(0, 10).join(', ')}
- Common cons: ${data.allCons.slice(0, 10).join(', ')}

Individual review summaries:
- ${data.reviewSummaries}

Write a 2-3 sentence honest summary of this restaurant based on TikTok reviews.
Be specific about dishes. Mention both positives and negatives if present.
Don't start with "This restaurant" — be more engaging.
Don't use marketing language. Write like a trusted friend giving advice.`;

  return generateText({
    model: MODELS.summarize,
    prompt,
    temperature: 0.7,
    maxOutputTokens: 200,
  });
}

async function updateBasicStats(
  restaurantId: string,
  reviews: any[]
): Promise<void> {
  const avgSentiment =
    reviews.reduce((sum: number, r: any) => sum + (r.sentiment_score || 0), 0) /
    reviews.length;

  const authenticReviews = reviews.filter((r) => !r.is_sponsored);
  const authenticityScore = authenticReviews.length / reviews.length;

  await supabase
    .from('restaurants')
    .update({
      review_count: reviews.length,
      avg_sentiment: avgSentiment,
      authenticity_score: authenticityScore,
      updated_at: new Date().toISOString(),
    })
    .eq('id', restaurantId);
}

// Count frequency of items and deduplicate
function deduplicateAndCount(
  items: string[]
): Array<{ item: string; count: number }> {
  const counts: Record<string, number> = {};
  items.forEach((item) => {
    const normalized = item.toLowerCase().trim();
    if (normalized) counts[normalized] = (counts[normalized] || 0) + 1;
  });
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([item, count]) => ({ item, count }));
}