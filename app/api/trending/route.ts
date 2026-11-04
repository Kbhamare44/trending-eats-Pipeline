/**
 * GET /api/trending
 *
 * "Trending on Trending Eats — <city>". The naming is deliberate and should
 * not be loosened: this ranks momentum within our own app from our own
 * signals. It is not a measure of TikTok popularity and must never be
 * presented as one.
 *
 * Query params:
 *   city      — canonical GTA city name, or 'all'
 *   region    — Toronto | Peel | York | Durham | Halton
 *   cuisine   — substring match
 *   gtaOnly   — 'false' to include out-of-market rows (default true)
 *   include   — 'warming' to append non-ranked entries after the ranked ones
 *   limit     — default 20, max 100
 */

import type { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase/client';
import { TREND_CONFIG } from '@/lib/config/trends';
import {
  presentRestaurant,
  RESTAURANT_COLUMNS,
} from '@/lib/presenters/restaurant';
import { ok, serverError, intParam } from '@/lib/http/respond';
import { resolveGtaCity } from '@/lib/geo/gta';

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const city = params.get('city');
    const region = params.get('region');
    const cuisine = params.get('cuisine');
    const gtaOnly = params.get('gtaOnly') !== 'false';
    const includeWarming = params.get('include') === 'warming';
    const limit = intParam(params.get('limit'), 20, 100);

    function base() {
      let query = supabase.from('restaurants').select(RESTAURANT_COLUMNS);

      if (gtaOnly) query = query.eq('is_gta', true);
      if (region) query = query.eq('region', region);
      if (cuisine) query = query.ilike('cuisine_type', `%${cuisine}%`);

      if (city && city !== 'all') {
        // Match the canonical city plus its neighbourhood aliases, so a
        // Woodbridge address still shows under Vaughan.
        const resolved = resolveGtaCity(city);
        if (resolved) {
          const names = [resolved.name, ...resolved.aliases];
          query = query.or(
            names.map((n) => `city.ilike.%${n}%`).join(',')
          );
        } else {
          query = query.ilike('city', `%${city}%`);
        }
      }

      return query;
    }

    const { data: ranked, error: rankedError } = await base()
      .eq('trend_state', 'ranked')
      .order('trend_score', { ascending: false, nullsFirst: false })
      .limit(limit);

    if (rankedError) throw rankedError;

    const results = [...(ranked ?? [])];

    // When there is not enough first-party activity to rank anything yet —
    // which is the honest state of the app today — return the warming-up and
    // no-data rows too, clearly flagged, rather than an empty screen.
    if (includeWarming || results.length < limit) {
      const { data: rest, error: restError } = await base()
        .neq('trend_state', 'ranked')
        .order('review_count', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(limit - results.length);

      if (restError) throw restError;
      results.push(...(rest ?? []));
    }

    const restaurants = results.map(presentRestaurant);
    const rankedCount = restaurants.filter(
      (r) => r.trend.state === 'ranked'
    ).length;

    return ok({
      restaurants,
      meta: {
        // The app renders this verbatim as the section heading, so the
        // provenance claim stays accurate wherever it is shown.
        heading: `Trending on Trending Eats${
          city && city !== 'all' ? ` — ${city}` : ' — GTA'
        }`,
        scope: 'first_party_signals_only',
        windowDays: TREND_CONFIG.windowDays,
        minObservations: TREND_CONFIG.minObservations,
        rankedCount,
        totalCount: restaurants.length,
        /** True when nothing has enough data to rank — the app says so. */
        rankingUnavailable: rankedCount === 0,
        note:
          rankedCount === 0
            ? `No restaurant has reached ${TREND_CONFIG.minObservations} recent signals yet, so nothing is ranked. Showing recently added spots instead.`
            : null,
      },
    });
  } catch (err) {
    return serverError(err, 'API/trending');
  }
}
