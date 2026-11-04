/**
 * Trend + experience recompute.
 *
 * Runs on a schedule (app/api/cron/recompute) and after each accepted
 * submission. Reads windowed counts from the SQL aggregate functions added in
 * migration 005, scores them in TypeScript, and writes the results back.
 *
 * Every pass also writes a row to `trend_snapshots`, which is what will later
 * let the weights in lib/config/trends.ts be tuned against observed data
 * rather than guessed at a second time.
 */

import { supabase } from '@/lib/supabase/client';
import { TREND_CONFIG } from '@/lib/config/trends';
import { computeTrendScore, computeHypeScore, TrendResult } from './score';
import {
  computeExperienceSignal,
  compareHypeToReality,
} from '@/lib/experience/signal';
import { syncAllRestaurantDishes } from '@/lib/dishes/aggregate';

interface RestaurantTrendInputRow {
  restaurant_id: string;
  unique_saves_current: number;
  unique_saves_previous: number;
  submissions_current: number;
  submissions_previous: number;
  unique_users_current: number;
  unique_users_previous: number;
  hours_since_last_activity: number | null;
  observations: number;
}

interface DishTrendInputRow {
  dish_id: string;
  mentions_current: number;
  mentions_previous: number;
  unique_saves_current: number;
  unique_saves_previous: number;
  unique_users_current: number;
  unique_users_previous: number;
  restaurant_count: number;
  hours_since_last_activity: number | null;
  observations: number;
}

interface ExperienceInputRow {
  restaurant_id: string;
  first_party_ratings: number[] | null;
  google_rating: number | null;
  google_rating_count: number | null;
  creator_sentiment: number | null;
  creator_review_count: number;
}

async function snapshot(
  entityType: 'restaurant' | 'dish',
  entityId: string,
  result: TrendResult,
  city: string | null
): Promise<void> {
  await supabase.from('trend_snapshots').insert({
    entity_type: entityType,
    entity_id: entityId,
    window_days: TREND_CONFIG.windowDays,
    score: result.score,
    state: result.state,
    confidence: result.confidence,
    observations: result.observations,
    components: result.components,
    city,
  });
}

// ── Restaurants ─────────────────────────────────────────────────────────────

export async function recomputeRestaurantTrends(): Promise<{
  evaluated: number;
  ranked: number;
  warmingUp: number;
  insufficient: number;
}> {
  const { data: inputs, error } = await supabase.rpc(
    'te_restaurant_trend_inputs',
    { window_days: TREND_CONFIG.windowDays }
  );

  if (error) {
    throw new Error(`te_restaurant_trend_inputs failed: ${error.message}`);
  }

  // Restaurants with zero events do not appear in the RPC output at all, but
  // they still need their state written — otherwise a restaurant that was
  // ranked last week keeps a stale score forever.
  const { data: allRestaurants } = await supabase
    .from('restaurants')
    .select('id, city, review_count, saves_count');

  const inputsById = new Map<string, RestaurantTrendInputRow>(
    ((inputs ?? []) as RestaurantTrendInputRow[]).map((row) => [
      row.restaurant_id,
      row,
    ])
  );

  let ranked = 0;
  let warmingUp = 0;
  let insufficient = 0;

  for (const restaurant of allRestaurants ?? []) {
    const row = inputsById.get(restaurant.id);

    const result = computeTrendScore({
      uniqueSavesCurrent: row?.unique_saves_current ?? 0,
      uniqueSavesPrevious: row?.unique_saves_previous ?? 0,
      submissionsCurrent: row?.submissions_current ?? 0,
      submissionsPrevious: row?.submissions_previous ?? 0,
      uniqueUsersCurrent: row?.unique_users_current ?? 0,
      uniqueUsersPrevious: row?.unique_users_previous ?? 0,
      hoursSinceLastActivity: row?.hours_since_last_activity ?? null,
      observations: row?.observations ?? 0,
    });

    const hypeScore = computeHypeScore({
      reviewCount: restaurant.review_count ?? 0,
      savesCount: restaurant.saves_count ?? 0,
      uniqueUsers: row?.unique_users_current ?? 0,
    });

    await supabase
      .from('restaurants')
      .update({
        trend_score: result.score,
        trend_state: result.state,
        trend_confidence: result.confidence,
        trend_observations: result.observations,
        trend_components: {
          ...result.components,
          explanation: result.explanation,
        },
        trend_computed_at: new Date().toISOString(),
        hype_score: hypeScore,
      })
      .eq('id', restaurant.id);

    await snapshot('restaurant', restaurant.id, result, restaurant.city ?? null);

    if (result.state === 'ranked') ranked++;
    else if (result.state === 'warming_up') warmingUp++;
    else insufficient++;
  }

  return {
    evaluated: allRestaurants?.length ?? 0,
    ranked,
    warmingUp,
    insufficient,
  };
}

// ── Dishes ──────────────────────────────────────────────────────────────────

export async function recomputeDishTrends(): Promise<{
  evaluated: number;
  ranked: number;
}> {
  const { data: inputs, error } = await supabase.rpc('te_dish_trend_inputs', {
    window_days: TREND_CONFIG.windowDays,
  });

  if (error) throw new Error(`te_dish_trend_inputs failed: ${error.message}`);

  let ranked = 0;
  const rows = (inputs ?? []) as DishTrendInputRow[];

  for (const row of rows) {
    const result = computeTrendScore({
      // For a dish, "submissions" are new mentions of it.
      uniqueSavesCurrent: row.unique_saves_current,
      uniqueSavesPrevious: row.unique_saves_previous,
      submissionsCurrent: row.mentions_current,
      submissionsPrevious: row.mentions_previous,
      uniqueUsersCurrent: row.unique_users_current,
      uniqueUsersPrevious: row.unique_users_previous,
      hoursSinceLastActivity: row.hours_since_last_activity,
      observations: row.observations,
    });

    // A dish also has to show up in enough places to be called a trend at
    // all. One restaurant's signature item is not a local food trend.
    const spreadOk =
      row.restaurant_count >= TREND_CONFIG.dishMinRestaurants &&
      row.mentions_current + row.mentions_previous >= TREND_CONFIG.dishMinMentions;

    const finalResult: TrendResult =
      result.state === 'ranked' && !spreadOk
        ? {
            ...result,
            score: null,
            state: 'warming_up',
            explanation: `Seen at ${row.restaurant_count} ${
              row.restaurant_count === 1 ? 'spot' : 'spots'
            } — needs ${TREND_CONFIG.dishMinRestaurants} to rank as a local trend.`,
          }
        : result;

    await supabase
      .from('dishes')
      .update({
        trend_score: finalResult.score,
        trend_state: finalResult.state,
        trend_confidence: finalResult.confidence,
        trend_observations: finalResult.observations,
        trend_components: {
          ...finalResult.components,
          explanation: finalResult.explanation,
          restaurant_count: row.restaurant_count,
        },
        trend_computed_at: new Date().toISOString(),
      })
      .eq('id', row.dish_id);

    await snapshot('dish', row.dish_id, finalResult, null);

    if (finalResult.state === 'ranked') ranked++;
  }

  return { evaluated: rows.length, ranked };
}

// ── Experience / Hype vs Reality ────────────────────────────────────────────

export async function recomputeExperienceSignals(): Promise<{
  evaluated: number;
  measured: number;
  insufficient: number;
}> {
  const { data: inputs, error } = await supabase.rpc(
    'te_restaurant_experience_inputs'
  );

  if (error) {
    throw new Error(`te_restaurant_experience_inputs failed: ${error.message}`);
  }

  const { data: hypeRows } = await supabase
    .from('restaurants')
    .select('id, hype_score');

  const hypeById = new Map<string, number | null>(
    (hypeRows ?? []).map((r) => [r.id, r.hype_score])
  );

  let measured = 0;
  let insufficient = 0;
  const rows = (inputs ?? []) as ExperienceInputRow[];

  for (const row of rows) {
    const ratings = (row.first_party_ratings ?? []).filter(
      (r): r is number => typeof r === 'number'
    );

    const experience = computeExperienceSignal({
      firstPartyRatings: ratings,
      googleRating: row.google_rating,
      googleRatingCount: row.google_rating_count,
      creatorSentiment: row.creator_sentiment,
      creatorReviewCount: row.creator_review_count ?? 0,
    });

    const comparison = compareHypeToReality(
      hypeById.get(row.restaurant_id) ?? null,
      experience
    );

    const firstPartyAvg =
      ratings.length > 0
        ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100
        : null;

    await supabase
      .from('restaurants')
      .update({
        experience_score: experience.score,
        experience_state: experience.state,
        experience_confidence: experience.confidence,
        experience_observations: experience.observations,
        experience_inputs: {
          inputs: experience.inputs,
          explanation: experience.explanation,
          comparison,
        },
        experience_computed_at: new Date().toISOString(),
        hype_vs_reality: comparison.verdict,
        first_party_rating: firstPartyAvg,
        first_party_rating_count: ratings.length,
      })
      .eq('id', row.restaurant_id);

    if (experience.state === 'measured') measured++;
    else insufficient++;
  }

  return { evaluated: rows.length, measured, insufficient };
}

// ── Full pass ───────────────────────────────────────────────────────────────

export interface RecomputeSummary {
  dishes: Awaited<ReturnType<typeof syncAllRestaurantDishes>>;
  restaurantTrends: Awaited<ReturnType<typeof recomputeRestaurantTrends>>;
  dishTrends: Awaited<ReturnType<typeof recomputeDishTrends>>;
  experience: Awaited<ReturnType<typeof recomputeExperienceSignals>>;
  windowDays: number;
  minObservations: number;
  computedAt: string;
}

/**
 * Order matters: dishes must be synced before dish trends can be scored, and
 * hype_score is written by the restaurant pass before the experience pass
 * compares against it.
 */
export async function recomputeAll(): Promise<RecomputeSummary> {
  const dishes = await syncAllRestaurantDishes();
  const restaurantTrends = await recomputeRestaurantTrends();
  const dishTrends = await recomputeDishTrends();
  const experience = await recomputeExperienceSignals();

  return {
    dishes,
    restaurantTrends,
    dishTrends,
    experience,
    windowDays: TREND_CONFIG.windowDays,
    minObservations: TREND_CONFIG.minObservations,
    computedAt: new Date().toISOString(),
  };
}
