/**
 * Dish aggregation — turns the free-text `reviews.dishes_mentioned` arrays
 * into first-class dish rows, so a dish can be ranked across restaurants.
 */

import { supabase } from '@/lib/supabase/client';
import { classifyDish, DishClassification } from './normalize';
import { bestTrigramMatch, TrigramCandidate } from './similarity';
import { DISH_MATCH, classifyEmbeddingSimilarity } from '@/lib/config/dishes';
import {
  embed,
  toPgVector,
  isEmbeddingConfigured,
  dishEmbeddingInput,
  EMBEDDING_MODEL_TAG,
} from '@/lib/openai/client';

/** In-process cache so one sync pass does not re-query the same dish. */
const dishIdCache = new Map<string, string>();

/**
 * Existing dish names, held for in-memory trigram comparison.
 *
 * Loaded once per process and appended to on create. See
 * lib/dishes/similarity.ts for why this is not a SQL query.
 */
let trigramCandidates: TrigramCandidate[] | null = null;

async function loadTrigramCandidates(): Promise<TrigramCandidate[]> {
  if (trigramCandidates) return trigramCandidates;

  const { data, error } = await supabase
    .from('dishes')
    .select('id, name, slug')
    .limit(DISH_MATCH.trigramCandidateLimit);

  if (error) {
    // Rung (b) is an optimisation. Losing it means more embedding calls, not
    // a wrong answer, so do not fail the whole resolve over it.
    console.warn('[Dishes] trigram candidates unavailable:', error.message);
    trigramCandidates = [];
    return trigramCandidates;
  }

  // Compared against normalized names, so normalize the stored display names
  // once here rather than on every comparison.
  trigramCandidates = (data ?? []).map((row: any) => ({
    id: row.id,
    slug: row.slug,
    name: String(row.name ?? '').toLowerCase(),
  }));
  return trigramCandidates;
}

/** Keep the in-memory candidate list in step with a newly created dish. */
function rememberCandidate(candidate: TrigramCandidate): void {
  if (trigramCandidates) trigramCandidates.push(candidate);
}

/** Forget cached state. Used by the backfill and by tests. */
export function resetDishCaches(): void {
  dishIdCache.clear();
  trigramCandidates = null;
}

export interface DishReviewFlag {
  candidateId: string;
  candidateName: string;
  similarity: number;
}

export interface ResolvedDish {
  id: string;
  classification: DishClassification;
  /** Which rung of the ladder resolved this name. */
  matchedBy: 'cache' | 'alias' | 'slug' | 'trigram' | 'embedding' | 'created';
  /**
   * Set when the embedding rung found a near-duplicate it is NOT confident
   * enough to merge. The dish was still created; this is a signal for a human
   * to add one alias row, not an automatic decision.
   */
  review?: DishReviewFlag;
}

/**
 * Store a vector on a dish. Never throws — a dish without an embedding is
 * fully usable, it just misses rung (c) next time.
 */
async function storeEmbedding(dishId: string, vector: number[]): Promise<void> {
  const { error } = await supabase
    .from('dishes')
    .update({
      embedding: toPgVector(vector),
      embedding_model: EMBEDDING_MODEL_TAG,
      embedded_at: new Date().toISOString(),
    })
    .eq('id', dishId);

  if (error) {
    console.warn(`[Dishes] could not store embedding for ${dishId}: ${error.message}`);
  }
}

async function recordAlias(
  alias: string,
  dishId: string,
  source: string
): Promise<void> {
  const { error } = await supabase
    .from('dish_aliases')
    .upsert({ alias, dish_id: dishId, source }, { onConflict: 'alias' });
  if (error) {
    console.warn(`[Dishes] could not record alias "${alias}": ${error.message}`);
  }
}

/**
 * Find or create the canonical dish for a raw name.
 *
 * A LADDER, CHEAPEST FIRST, so OpenAI is only called when the free passes
 * miss:
 *
 *   a. alias table         exact, free, and manual corrections always win
 *   b. slug                exact, free — the normalized form of this name
 *   c. trigram             free, in memory, catches spelling and plural drift
 *   d. embedding           one API call; flags near-duplicates for review
 *   e. create              and embed the new dish so it can be matched later
 *
 * ON RUNG (d), AND WHY IT DOES NOT MERGE: embeddings were added here to catch
 * synonyms that spelling cannot, the canonical example being "birria tacos"
 * and "quesabirria". Measured with text-embedding-3-small, that pair scores
 * 0.388 — the lowest of twelve test pairs, below genuinely different dishes,
 * while "beef taco" and "fish taco" score 0.709. Four different input
 * templates were tried and in every one the lowest true match sat below the
 * highest false match, so no threshold separates them. The signal tracks
 * shared wording, not culinary identity.
 *
 * So this rung creates the dish and records a review flag rather than
 * merging. Real synonyms are a job for one alias row, or for an LLM asked to
 * classify a pair — a different task from nearest-neighbour search. See
 * lib/config/dishes.ts for the full measurements.
 *
 * Returns null when the raw string is not a usable dish name.
 */
export async function resolveDish(raw: string): Promise<ResolvedDish | null> {
  const classification = classifyDish(raw);
  if (!classification) return null;

  const cached = dishIdCache.get(classification.normalized);
  if (cached) return { id: cached, classification, matchedBy: 'cache' };

  // ── a. Alias table — manual corrections without a deploy ──
  const { data: alias } = await supabase
    .from('dish_aliases')
    .select('dish_id')
    .eq('alias', classification.normalized)
    .maybeSingle();

  if (alias?.dish_id) {
    dishIdCache.set(classification.normalized, alias.dish_id);
    return { id: alias.dish_id, classification, matchedBy: 'alias' };
  }

  // ── b. Existing dish with this exact slug ──
  const { data: existing } = await supabase
    .from('dishes')
    .select('id')
    .eq('slug', classification.slug)
    .maybeSingle();

  if (existing?.id) {
    dishIdCache.set(classification.normalized, existing.id);
    return { id: existing.id, classification, matchedBy: 'slug' };
  }

  // ── c. Trigram, in memory and free ──
  const candidates = await loadTrigramCandidates();
  const trigramHit = bestTrigramMatch(classification.normalized, candidates);

  if (trigramHit) {
    dishIdCache.set(classification.normalized, trigramHit.id);
    // Record it so the next occurrence short-circuits at rung (a) instead of
    // recomputing the comparison.
    await recordAlias(classification.normalized, trigramHit.id, 'trigram');
    return { id: trigramHit.id, classification, matchedBy: 'trigram' };
  }

  // ── d. Embedding: flag near-duplicates, do not merge ──
  let vector: number[] | null = null;
  let review: DishReviewFlag | undefined;

  if (isEmbeddingConfigured()) {
    try {
      vector = await embed(dishEmbeddingInput(classification.normalized));

      const { data: similar, error: rpcError } = await supabase.rpc(
        'te_similar_dishes',
        {
          query_embedding: toPgVector(vector),
          match_threshold: DISH_MATCH.embeddingAmbiguousThreshold,
          match_count: DISH_MATCH.embeddingMatchCount,
        }
      );

      if (rpcError) {
        console.warn('[Dishes] te_similar_dishes failed:', rpcError.message);
      } else if (Array.isArray(similar) && similar.length > 0) {
        const top = similar[0];
        const similarity = Number(top.similarity ?? 0);
        const verdict = classifyEmbeddingSimilarity(similarity);

        if (verdict === 'same' && DISH_MATCH.autoAlias) {
          dishIdCache.set(classification.normalized, top.id);
          await recordAlias(classification.normalized, top.id, 'embedding');
          return { id: top.id, classification, matchedBy: 'embedding' };
        }

        if (verdict === 'same' || verdict === 'review') {
          review = {
            candidateId: top.id,
            candidateName: top.name ?? top.slug ?? '',
            similarity,
          };
          console.log(
            `[Dishes] possible duplicate: "${classification.normalized}" ~ ` +
              `"${review.candidateName}" at ${similarity.toFixed(3)} ` +
              `(verdict=${verdict}, autoAlias=${DISH_MATCH.autoAlias}) — created separately`
          );
        }
      }
    } catch (err: any) {
      // Embedding is an enhancement. If OpenAI is down, fall through and
      // create the dish; the backfill can embed it later.
      console.warn(`[Dishes] embedding failed for "${raw}": ${err.message}`);
    }
  }

  // ── e. Create it ──
  const { data: created, error } = await supabase
    .from('dishes')
    .insert({
      slug: classification.slug,
      name: classification.displayName,
      family: classification.family,
      category: classification.category,
      ...(vector
        ? {
            embedding: toPgVector(vector),
            embedding_model: EMBEDDING_MODEL_TAG,
            embedded_at: new Date().toISOString(),
          }
        : {}),
    })
    .select('id')
    .single();

  if (error) {
    // Lost a race against a concurrent insert — re-read.
    const { data: raced } = await supabase
      .from('dishes')
      .select('id')
      .eq('slug', classification.slug)
      .maybeSingle();
    if (raced?.id) {
      dishIdCache.set(classification.normalized, raced.id);
      return { id: raced.id, classification, matchedBy: 'slug' };
    }
    console.error(`[Dishes] Could not resolve "${raw}":`, error.message);
    return null;
  }

  // Record the normalized form as a rule-sourced alias, so future variants
  // that normalize the same way hit the alias index directly.
  await recordAlias(classification.normalized, created.id, 'rule');

  rememberCandidate({
    id: created.id,
    slug: classification.slug,
    name: classification.normalized,
  });
  dishIdCache.set(classification.normalized, created.id);

  return { id: created.id, classification, matchedBy: 'created', review };
}

/**
 * Rebuild dish_mentions and restaurant_dishes for one restaurant from its
 * reviews. Idempotent — the unique (dish_id, review_id) constraint means
 * re-running will not double-count.
 */
export async function syncRestaurantDishes(
  restaurantId: string
): Promise<{
  dishesLinked: number;
  mentionsRecorded: number;
  /**
   * Near-duplicates the embedding rung flagged but did not merge. Surfaced
   * rather than only logged, so the cron can report a count and these do not
   * silently accumulate where nobody looks.
   */
  reviewFlags: DishReviewFlag[];
}> {
  const { data: reviews, error } = await supabase
    .from('reviews')
    .select('id, dishes_mentioned, sentiment_score, created_at')
    .eq('restaurant_id', restaurantId);

  if (error) throw new Error(`Failed to read reviews: ${error.message}`);
  if (!reviews || reviews.length === 0) {
    return { dishesLinked: 0, mentionsRecorded: 0, reviewFlags: [] };
  }

  const reviewFlags: DishReviewFlag[] = [];

  // dish_id -> rolled-up stats for this restaurant
  interface DishStats {
    mentions: number;
    reviewIds: Set<string>;
    sentiments: number[];
    firstSeen: string;
    lastSeen: string;
  }
  const perDish = new Map<string, DishStats>();

  const mentionRows: Array<{
    dish_id: string;
    restaurant_id: string;
    review_id: string;
    raw_name: string;
    sentiment: number | null;
    created_at: string;
  }> = [];

  for (const review of reviews) {
    const rawDishes: unknown = review.dishes_mentioned;
    if (!Array.isArray(rawDishes)) continue;

    // Dedupe within a single review so one caption saying "burger" three
    // times counts as one mention, not three.
    const seenInThisReview = new Set<string>();

    for (const raw of rawDishes) {
      if (typeof raw !== 'string') continue;
      const resolved = await resolveDish(raw);
      if (!resolved) continue;
      if (resolved.review) reviewFlags.push(resolved.review);
      if (seenInThisReview.has(resolved.id)) continue;
      seenInThisReview.add(resolved.id);

      mentionRows.push({
        dish_id: resolved.id,
        restaurant_id: restaurantId,
        review_id: review.id,
        raw_name: raw,
        sentiment: review.sentiment_score ?? null,
        created_at: review.created_at,
      });

      const stats: DishStats = perDish.get(resolved.id) ?? {
        mentions: 0,
        reviewIds: new Set<string>(),
        sentiments: [],
        firstSeen: review.created_at,
        lastSeen: review.created_at,
      };
      stats.mentions += 1;
      stats.reviewIds.add(review.id);
      if (typeof review.sentiment_score === 'number') {
        stats.sentiments.push(review.sentiment_score);
      }
      if (review.created_at < stats.firstSeen) stats.firstSeen = review.created_at;
      if (review.created_at > stats.lastSeen) stats.lastSeen = review.created_at;
      perDish.set(resolved.id, stats);
    }
  }

  if (mentionRows.length > 0) {
    const { error: mentionError } = await supabase
      .from('dish_mentions')
      .upsert(mentionRows, { onConflict: 'dish_id,review_id' });
    if (mentionError) {
      console.error('[Dishes] mention upsert failed:', mentionError.message);
    }
  }

  const joinRows = [...perDish.entries()].map(([dishId, stats]) => ({
    restaurant_id: restaurantId,
    dish_id: dishId,
    mention_count: stats.mentions,
    review_count: stats.reviewIds.size,
    avg_sentiment:
      stats.sentiments.length > 0
        ? stats.sentiments.reduce((a, b) => a + b, 0) / stats.sentiments.length
        : null,
    first_seen: stats.firstSeen,
    last_seen: stats.lastSeen,
  }));

  if (joinRows.length > 0) {
    const { error: joinError } = await supabase
      .from('restaurant_dishes')
      .upsert(joinRows, { onConflict: 'restaurant_id,dish_id' });
    if (joinError) {
      console.error('[Dishes] restaurant_dishes upsert failed:', joinError.message);
    }
  }

  return {
    dishesLinked: joinRows.length,
    mentionsRecorded: mentionRows.length,
    reviewFlags,
  };
}

/** Refresh the denormalized counters on `dishes`. */
export async function refreshDishCounters(): Promise<number> {
  const { data: rows, error } = await supabase
    .from('restaurant_dishes')
    .select('dish_id, restaurant_id, mention_count');

  if (error) throw new Error(`Failed to read restaurant_dishes: ${error.message}`);
  if (!rows) return 0;

  const totals = new Map<string, { restaurants: Set<string>; mentions: number }>();
  for (const row of rows) {
    const entry = totals.get(row.dish_id) ?? { restaurants: new Set<string>(), mentions: 0 };
    entry.restaurants.add(row.restaurant_id);
    entry.mentions += row.mention_count ?? 0;
    totals.set(row.dish_id, entry);
  }

  let updated = 0;
  for (const [dishId, entry] of totals) {
    const { error: updateError } = await supabase
      .from('dishes')
      .update({
        restaurant_count: entry.restaurants.size,
        mention_count: entry.mentions,
        updated_at: new Date().toISOString(),
      })
      .eq('id', dishId);
    if (!updateError) updated++;
  }

  return updated;
}

/** Rebuild dish data for every restaurant. Used by the recompute cron. */
export async function syncAllRestaurantDishes(): Promise<{
  restaurants: number;
  dishesLinked: number;
  mentionsRecorded: number;
  possibleDuplicates: number;
}> {
  const { data: restaurants, error } = await supabase
    .from('restaurants')
    .select('id');

  if (error) throw new Error(`Failed to list restaurants: ${error.message}`);

  let dishesLinked = 0;
  let mentionsRecorded = 0;
  let possibleDuplicates = 0;

  for (const restaurant of restaurants ?? []) {
    try {
      const result = await syncRestaurantDishes(restaurant.id);
      dishesLinked += result.dishesLinked;
      mentionsRecorded += result.mentionsRecorded;
      possibleDuplicates += result.reviewFlags.length;
    } catch (err: any) {
      console.error(`[Dishes] sync failed for ${restaurant.id}:`, err.message);
    }
  }

  await refreshDishCounters();

  return {
    restaurants: restaurants?.length ?? 0,
    dishesLinked,
    mentionsRecorded,
    possibleDuplicates,
  };
}
