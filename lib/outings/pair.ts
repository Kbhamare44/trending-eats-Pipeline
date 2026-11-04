/**
 * Outing pairings: one restaurant, one nearby thing to do, the walk between.
 *
 * ── WHY THIS IS NOT AN OPTIMIZER ──
 *
 * A real itinerary planner has to check opening hours and travel time against
 * each other — a 7pm dinner and an 8:40 showing 25 minutes apart does not
 * work — and that is ordinary arithmetic, not a prompt. It is also a week of
 * work that assumes people want the feature. This is the version that finds
 * out: a pairing, with the walking time, and nothing scheduled.
 *
 * ── THE HONEST PART ──
 *
 * "One TRENDING restaurant plus something nearby" presumes a trending
 * restaurant exists. With four restaurants and no users nothing is ranked, so
 * the pairing would silently be "one arbitrary restaurant" while the UI
 * implied momentum. Every pairing therefore carries the restaurant's trend
 * state and the response says plainly which basis was used. The app shows
 * "Recently added" rather than "Trending" when that is the truth.
 *
 * ── THE COST PART ──
 *
 * Ranking is haversine, computed locally and free. The Routes API bills per
 * element, so it is called once per RETURNED pairing — never per candidate.
 * One request therefore bills at most OUTING_MAX_PAIRINGS elements.
 */

import { supabase } from '@/lib/supabase/client';
import { OUTING_CONFIG } from '@/lib/config/outings';
import { findNearbyActivities, type NearbyActivity } from '@/lib/google/nearby';
import { walkingLeg } from '@/lib/google/routes';
import { haversineMetres, estimateWalkMinutes } from '@/lib/geo/distance';

export interface PairedActivity {
  id: string | null;
  placeId: string;
  name: string;
  category: string;
  address: string | null;
  latitude: number;
  longitude: number;
  googleRating: number | null;
  googleRatingCount: number | null;
  priceLevel: number | null;
  attribution: string[];
}

export interface OutingPairing {
  restaurant: {
    id: string;
    name: string;
    city: string | null;
    cuisineType: string | null;
    priceLevel: number | null;
    latitude: number;
    longitude: number;
    /** 'ranked' | 'warming_up' | 'insufficient_data'. */
    trendState: string;
  };
  activity: PairedActivity;
  walk: {
    minutes: number;
    metres: number;
    /** False means a straight-line estimate, not a measured route. */
    measured: boolean;
  };
  /** Render-ready, and never claims momentum we cannot support. */
  headline: string;
}

export interface PairingResult {
  pairings: OutingPairing[];
  meta: {
    basis: 'ranked' | 'recent';
    note: string | null;
    restaurantsConsidered: number;
    activitiesConsidered: number;
    routesCalled: number;
    /**
     * Set when the activity search could not run at all.
     *
     * This exists because the first version of this code was quietly
     * dishonest in exactly the way the rest of the codebase is built to
     * avoid. When the Places key is denied — billing disabled, or the API
     * not enabled on the project — findNearbyActivities throws, the loop
     * caught it and continued, and the response said "we need restaurants
     * with something walkable nearby". That is a false statement about
     * Toronto. The truth was that we never asked Google.
     */
    searchFailed: boolean;
    searchError: string | null;
  };
}

/**
 * Store or refresh an activity row and return its id.
 *
 * Places terms limit how long most fields may be retained, so `refreshed_at`
 * is written on every upsert and `activityTtlHours` governs reuse. Returns
 * null rather than throwing: a pairing is still useful if we failed to cache
 * the activity, and `is_gta`/`region` are set by the te_activity_geography
 * trigger either way.
 */
async function upsertActivity(activity: NearbyActivity): Promise<string | null> {
  const { data, error } = await supabase
    .from('activities')
    .upsert(
      {
        google_place_id: activity.placeId,
        name: activity.name,
        category: activity.category,
        address: activity.address,
        latitude: activity.latitude,
        longitude: activity.longitude,
        price_level: activity.priceLevel,
        google_rating: activity.googleRating,
        opening_hours: activity.openingHours ?? null,
        refreshed_at: activity.fetchedAt,
      },
      { onConflict: 'google_place_id' }
    )
    .select('id')
    .maybeSingle();

  if (error) {
    console.warn(`[Outings] could not cache "${activity.name}": ${error.message}`);
    return null;
  }
  return data?.id ?? null;
}

function headlineFor(restaurantName: string, activityName: string, trendState: string): string {
  // The wording tracks what we can actually support. Calling a restaurant
  // with no activity data "trending" is the exact conflation the rest of this
  // codebase exists to avoid.
  const lead =
    trendState === 'ranked'
      ? `${restaurantName}, which people are posting about`
      : trendState === 'warming_up'
        ? `${restaurantName}, starting to get attention`
        : restaurantName;
  return `${lead}, then ${activityName}`;
}

export async function buildPairings(options: {
  city?: string | null;
  limit?: number;
}): Promise<PairingResult> {
  const limit = Math.max(1, Math.min(options.limit ?? OUTING_CONFIG.maxPairings, OUTING_CONFIG.maxPairings));

  // Ranked restaurants first. Ask for more than `limit` because some will
  // have nothing walkable nearby and be discarded.
  const columns =
    'id, name, city, cuisine_type, price_level, latitude, longitude, trend_state, trend_score, created_at';

  let query = supabase
    .from('restaurants')
    .select(columns)
    .eq('is_gta', true)
    .not('latitude', 'is', null)
    .not('longitude', 'is', null);

  if (options.city && options.city !== 'all') {
    query = query.eq('city', options.city);
  }

  const { data: ranked, error: rankedError } = await query
    .eq('trend_state', 'ranked')
    .order('trend_score', { ascending: false })
    .limit(limit * 2);

  if (rankedError) throw new Error(`Could not read restaurants: ${rankedError.message}`);

  let candidates = ranked ?? [];
  let basis: 'ranked' | 'recent' = 'ranked';
  let note: string | null = null;

  if (candidates.length === 0) {
    // Nothing is ranked. Fall back to recently added and SAY SO, rather than
    // presenting an arbitrary restaurant as one that is trending.
    let fallback = supabase
      .from('restaurants')
      .select(columns)
      .eq('is_gta', true)
      .not('latitude', 'is', null)
      .not('longitude', 'is', null);

    if (options.city && options.city !== 'all') {
      fallback = fallback.eq('city', options.city);
    }

    const { data: recent, error: recentError } = await fallback
      .order('created_at', { ascending: false })
      .limit(limit * 2);

    if (recentError) throw new Error(`Could not read restaurants: ${recentError.message}`);

    candidates = recent ?? [];
    basis = 'recent';
    note =
      'No restaurant has enough recent activity to rank yet, so these are recently added spots rather than trending ones.';
  }

  const pairings: OutingPairing[] = [];
  let activitiesConsidered = 0;
  let routesCalled = 0;
  let searchAttempts = 0;
  let searchFailures = 0;
  let firstError: string | null = null;

  for (const restaurant of candidates) {
    if (pairings.length >= limit) break;

    let nearby: NearbyActivity[] = [];
    searchAttempts++;
    try {
      nearby = await findNearbyActivities(restaurant.latitude, restaurant.longitude);
    } catch (err: any) {
      searchFailures++;
      if (!firstError) firstError = err?.message ?? String(err);
      console.warn(`[Outings] nearby search failed for ${restaurant.name}: ${err.message}`);
      continue;
    }
    activitiesConsidered += nearby.length;

    // Rank on straight-line distance — free — and discard anything too far
    // BEFORE spending a Routes element on it.
    const scored = nearby
      .map((activity) => ({
        activity,
        metres: haversineMetres(
          { latitude: restaurant.latitude, longitude: restaurant.longitude },
          { latitude: activity.latitude, longitude: activity.longitude }
        ),
      }))
      .filter((c) => c.metres <= OUTING_CONFIG.maxStraightLineM)
      .sort((a, b) => a.metres - b.metres);

    const best = scored[0];
    if (!best) continue;

    // One Routes element, for the pair already chosen.
    const measured = await walkingLeg(
      { latitude: restaurant.latitude, longitude: restaurant.longitude },
      { latitude: best.activity.latitude, longitude: best.activity.longitude }
    );
    if (measured) routesCalled++;

    const activityId = await upsertActivity(best.activity);

    pairings.push({
      restaurant: {
        id: restaurant.id,
        name: restaurant.name,
        city: restaurant.city ?? null,
        cuisineType: restaurant.cuisine_type ?? null,
        priceLevel: restaurant.price_level ?? null,
        latitude: restaurant.latitude,
        longitude: restaurant.longitude,
        trendState: restaurant.trend_state ?? 'insufficient_data',
      },
      activity: {
        id: activityId,
        placeId: best.activity.placeId,
        name: best.activity.name,
        category: best.activity.category,
        address: best.activity.address,
        latitude: best.activity.latitude,
        longitude: best.activity.longitude,
        googleRating: best.activity.googleRating,
        googleRatingCount: best.activity.googleRatingCount,
        priceLevel: best.activity.priceLevel,
        attribution: best.activity.attribution,
      },
      walk: measured ?? {
        minutes: estimateWalkMinutes(best.metres, OUTING_CONFIG.walkMetresPerMinute),
        metres: Math.round(best.metres),
        measured: false,
      },
      headline: headlineFor(
        restaurant.name,
        best.activity.name,
        restaurant.trend_state ?? 'insufficient_data'
      ),
    });
  }

  // Every attempt failing means the provider is unreachable, not that the
  // neighbourhood is empty. Saying the wrong one of those sends somebody to
  // look for a bug in their own city.
  const searchFailed = searchAttempts > 0 && searchFailures === searchAttempts;

  let resolvedNote = note;
  if (searchFailed) {
    resolvedNote = 'We could not reach the activity search just now. Try again shortly.';
  } else if (pairings.length === 0) {
    resolvedNote = 'Nothing to pair yet — we need restaurants with something walkable nearby.';
  }

  return {
    pairings,
    meta: {
      basis,
      note: resolvedNote,
      restaurantsConsidered: candidates.length,
      activitiesConsidered,
      routesCalled,
      searchFailed,
      // The provider's own words, which is what makes a denied key
      // diagnosable from the response instead of only from the logs.
      searchError: searchFailed ? firstError : null,
    },
  };
}
