/**
 * Dish aggregation — turns the free-text `reviews.dishes_mentioned` arrays
 * into first-class dish rows, so a dish can be ranked across restaurants.
 */

import { supabase } from '@/lib/supabase/client';
import { classifyDish, DishClassification } from './normalize';

/** In-process cache so one sync pass does not re-query the same dish. */
const dishIdCache = new Map<string, string>();

/**
 * Find or create the canonical dish for a raw name.
 *
 * Lookup order: alias table (manual corrections win) -> slug -> create.
 * Returns null when the raw string is not a usable dish name.
 */
export async function resolveDish(
  raw: string
): Promise<{ id: string; classification: DishClassification } | null> {
  const classification = classifyDish(raw);
  if (!classification) return null;

  const cached = dishIdCache.get(classification.normalized);
  if (cached) return { id: cached, classification };

  // 1. Alias table — lets you correct a bad grouping without a deploy.
  const { data: alias } = await supabase
    .from('dish_aliases')
    .select('dish_id')
    .eq('alias', classification.normalized)
    .maybeSingle();

  if (alias?.dish_id) {
    dishIdCache.set(classification.normalized, alias.dish_id);
    return { id: alias.dish_id, classification };
  }

  // 2. Existing dish with this slug.
  const { data: existing } = await supabase
    .from('dishes')
    .select('id')
    .eq('slug', classification.slug)
    .maybeSingle();

  if (existing?.id) {
    dishIdCache.set(classification.normalized, existing.id);
    return { id: existing.id, classification };
  }

  // 3. Create it.
  const { data: created, error } = await supabase
    .from('dishes')
    .insert({
      slug: classification.slug,
      name: classification.displayName,
      family: classification.family,
      category: classification.category,
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
      return { id: raced.id, classification };
    }
    console.error(`[Dishes] Could not resolve "${raw}":`, error.message);
    return null;
  }

  // Record the normalized form as a rule-sourced alias, so future variants
  // that normalize the same way hit the alias index directly.
  await supabase
    .from('dish_aliases')
    .upsert(
      { alias: classification.normalized, dish_id: created.id, source: 'rule' },
      { onConflict: 'alias' }
    );

  dishIdCache.set(classification.normalized, created.id);
  return { id: created.id, classification };
}

/**
 * Rebuild dish_mentions and restaurant_dishes for one restaurant from its
 * reviews. Idempotent — the unique (dish_id, review_id) constraint means
 * re-running will not double-count.
 */
export async function syncRestaurantDishes(
  restaurantId: string
): Promise<{ dishesLinked: number; mentionsRecorded: number }> {
  const { data: reviews, error } = await supabase
    .from('reviews')
    .select('id, dishes_mentioned, sentiment_score, created_at')
    .eq('restaurant_id', restaurantId);

  if (error) throw new Error(`Failed to read reviews: ${error.message}`);
  if (!reviews || reviews.length === 0) {
    return { dishesLinked: 0, mentionsRecorded: 0 };
  }

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

  return { dishesLinked: joinRows.length, mentionsRecorded: mentionRows.length };
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
}> {
  const { data: restaurants, error } = await supabase
    .from('restaurants')
    .select('id');

  if (error) throw new Error(`Failed to list restaurants: ${error.message}`);

  let dishesLinked = 0;
  let mentionsRecorded = 0;

  for (const restaurant of restaurants ?? []) {
    try {
      const result = await syncRestaurantDishes(restaurant.id);
      dishesLinked += result.dishesLinked;
      mentionsRecorded += result.mentionsRecorded;
    } catch (err: any) {
      console.error(`[Dishes] sync failed for ${restaurant.id}:`, err.message);
    }
  }

  await refreshDishCounters();

  return {
    restaurants: restaurants?.length ?? 0,
    dishesLinked,
    mentionsRecorded,
  };
}
