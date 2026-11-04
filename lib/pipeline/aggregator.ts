/**
 * Review aggregation — rolls a restaurant's TikTok sources up into the
 * summary, dish list and authenticity figures shown on its page.
 *
 * Three bugs are fixed here relative to the previous version:
 *
 *  1. The summary was only generated when `reviews.length % 3 === 0`, with a
 *     minimum of 2. A restaurant with 2 reviews therefore never got one —
 *     2 % 3 = 2 — which is why Supreme Pizzeria sits in production with 2
 *     reviews and ai_summary = null. It now generates as soon as the minimum
 *     is met, and whenever a summary is missing.
 *
 *  2. pros/cons were counted by raw string, so "line longer than you'd expect"
 *     and the same text with a typographic apostrophe counted as two separate
 *     items. Now normalized through lib/dishes/normalize.
 *
 *  3. authenticity_score was written as 0 for restaurants with no reviews,
 *     which renders as a negative claim about a real business backed by no
 *     evidence. It is now null + authenticity_state = 'insufficient_data'.
 */

import { supabase } from '@/lib/supabase/client';
import { generateText, MODELS } from '@/lib/gemini/client';
import { getReviewsByRestaurant } from '@/lib/supabase/queries';
import { dedupeAndCount } from '@/lib/dishes/normalize';

/** Below this, we do not characterize a restaurant from creator reviews. */
const MIN_REVIEWS_FOR_SUMMARY = 2;
/** Refresh the summary every N reviews once it exists, to limit API spend. */
const REGENERATE_EVERY_N_REVIEWS = 3;

export async function aggregateRestaurantReviews(
  restaurantId: string
): Promise<void> {
  const reviews = await getReviewsByRestaurant(restaurantId);

  if (reviews.length === 0) {
    // Explicitly record "we know nothing" rather than leaving stale or
    // zero-valued scores behind.
    await supabase
      .from('restaurants')
      .update({
        review_count: 0,
        avg_sentiment: null,
        authenticity_score: null,
        authenticity_state: 'insufficient_data',
        updated_at: new Date().toISOString(),
      })
      .eq('id', restaurantId);
    return;
  }

  // ── Stats that are cheap and always worth refreshing ──────────────────────
  const avgSentiment =
    reviews.reduce((sum: number, r: any) => sum + (r.sentiment_score || 0), 0) /
    reviews.length;

  const authenticReviews = reviews.filter((r: any) => !r.is_sponsored);
  const avgAuthenticityWeight =
    reviews.reduce(
      (sum: number, r: any) => sum + (r.authenticity_weight ?? 1),
      0
    ) / reviews.length;

  const hasEnough = reviews.length >= MIN_REVIEWS_FOR_SUMMARY;

  const authenticityScore = hasEnough
    ? Math.min(
        1,
        (authenticReviews.length / reviews.length) * avgAuthenticityWeight
      )
    : null;

  // ── Dishes ────────────────────────────────────────────────────────────────
  // Kept as a denormalized convenience list on the restaurant row. The
  // rankable, cross-restaurant version lives in dishes/restaurant_dishes and
  // is built by lib/dishes/aggregate.
  const allDishes: string[] = reviews.flatMap((r: any) =>
    Array.isArray(r.dishes_mentioned) ? r.dishes_mentioned : []
  );
  const topDishes = dedupeAndCount(allDishes)
    .slice(0, 5)
    .map(({ item, count }) => ({ dish: item, mentions: count }));

  const allPros: string[] = reviews.flatMap((r: any) =>
    Array.isArray(r.pros) ? r.pros : []
  );
  const allCons: string[] = reviews.flatMap((r: any) =>
    Array.isArray(r.cons) ? r.cons : []
  );

  // ── Decide whether to (re)generate the AI summary ─────────────────────────
  const { data: current } = await supabase
    .from('restaurants')
    .select('ai_summary')
    .eq('id', restaurantId)
    .maybeSingle();

  const hasSummary = Boolean(current?.ai_summary);
  const shouldGenerate =
    hasEnough &&
    (!hasSummary || reviews.length % REGENERATE_EVERY_N_REVIEWS === 0);

  let aiSummary: string | null = current?.ai_summary ?? null;

  if (shouldGenerate) {
    console.log(
      `[Aggregator] Generating summary for ${restaurantId} (${reviews.length} reviews)`
    );
    try {
      const generated = await generateRestaurantSummary({
        reviewCount: reviews.length,
        authenticReviewCount: authenticReviews.length,
        avgSentiment,
        topDishes,
        allPros: dedupeAndCount(allPros).map((p) => p.item),
        allCons: dedupeAndCount(allCons).map((c) => c.item),
        reviewSummaries: reviews
          .slice(0, 10)
          .map((r: any) => r.reviewer_summary)
          .filter(Boolean)
          .join('\n- '),
        authenticityScore: authenticityScore ?? 0,
      });
      if (generated.trim()) aiSummary = generated.trim();
    } catch (err: any) {
      // A failed summary must not block the numeric stats from being written.
      console.error(
        `[Aggregator] Summary generation failed for ${restaurantId}:`,
        err.message
      );
    }
  } else if (!hasEnough) {
    console.log(
      `[Aggregator] ${restaurantId}: ${reviews.length} review(s), need ${MIN_REVIEWS_FOR_SUMMARY} to summarize`
    );
  }

  const { error } = await supabase
    .from('restaurants')
    .update({
      ai_summary: aiSummary,
      authenticity_score: authenticityScore,
      authenticity_state: hasEnough ? 'measured' : 'insufficient_data',
      review_count: reviews.length,
      avg_sentiment: avgSentiment,
      top_dishes: topDishes,
      common_pros: dedupeAndCount(allPros).slice(0, 5),
      common_cons: dedupeAndCount(allCons).slice(0, 5),
      updated_at: new Date().toISOString(),
    })
    .eq('id', restaurantId);

  if (error) {
    throw new Error(`Failed to update restaurant aggregate: ${error.message}`);
  }

  console.log(`[Aggregator] Updated ${restaurantId} (${reviews.length} reviews)`);
}

async function generateRestaurantSummary(data: {
  reviewCount: number;
  authenticReviewCount: number;
  avgSentiment: number;
  topDishes: Array<{ dish: string; mentions: number }>;
  allPros: string[];
  allCons: string[];
  reviewSummaries: string;
  authenticityScore: number;
}): Promise<string> {
  const sentimentLabel =
    data.avgSentiment > 0.3
      ? 'positive'
      : data.avgSentiment < -0.3
        ? 'negative'
        : 'mixed';

  const prompt = `You are writing a restaurant summary for a food discovery app.

Data from ${data.reviewCount} TikTok reviews (${data.authenticReviewCount} appear to be unsponsored):
- Overall creator sentiment: ${sentimentLabel} (score: ${data.avgSentiment.toFixed(2)})
- Share of reviews that appear unsponsored: ${(data.authenticityScore * 100).toFixed(0)}%
- Top dishes: ${data.topDishes.map((d) => `${d.dish} (${d.mentions}x)`).join(', ') || 'none recorded'}
- Mentioned positives: ${data.allPros.slice(0, 10).join(', ') || 'none recorded'}
- Mentioned negatives: ${data.allCons.slice(0, 10).join(', ') || 'none recorded'}

Individual review summaries:
- ${data.reviewSummaries}

Write a 2-3 sentence summary of this restaurant based on these reviews.
Be specific about dishes. Mention both positives and negatives if present.
Do not start with "This restaurant" — be more engaging.
Do not use marketing language. Write like a trusted friend giving advice.

Important: base every claim on the data above. This is a real business, so do
not invent details, and do not state a criticism that the reviews above do not
support. If the evidence is thin, say that the reviews are limited.`;

  return generateText({
    model: MODELS.summarize,
    prompt,
    temperature: 0.7,
    maxOutputTokens: 8192,
  });
}
