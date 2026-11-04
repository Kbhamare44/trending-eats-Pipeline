/**
 * GET /api/dishes
 *
 * Viral Dishes — tracks the food item, not just the restaurant, which is what
 * makes "matcha desserts are having a moment in Toronto" expressible at all.
 *
 * Query params:
 *   city     — restrict to dishes served in this GTA city
 *   family   — e.g. 'matcha', 'smash-burger'
 *   category — dessert | savoury | drink
 *   include  — 'warming' to append dishes that do not yet qualify to rank
 *   limit    — default 30, max 100
 */

import type { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase/client';
import { TREND_CONFIG } from '@/lib/config/trends';
import { presentDish } from '@/lib/presenters/restaurant';
import { ok, serverError, intParam } from '@/lib/http/respond';
import { resolveGtaCity } from '@/lib/geo/gta';

const DISH_COLUMNS = `
  id, slug, name, family, category, restaurant_count, mention_count,
  trend_score, trend_state, trend_confidence, trend_observations,
  trend_components, trend_computed_at
`;

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const city = params.get('city');
    const family = params.get('family');
    const category = params.get('category');
    const includeWarming = params.get('include') === 'warming';
    const limit = intParam(params.get('limit'), 30, 100);

    // City filtering needs the join: a dish is "in" a city if any restaurant
    // there serves it.
    let dishIdFilter: string[] | null = null;
    if (city && city !== 'all') {
      const resolved = resolveGtaCity(city);
      const names = resolved ? [resolved.name, ...resolved.aliases] : [city];

      const { data: cityRestaurants, error: cityError } = await supabase
        .from('restaurants')
        .select('id')
        .or(names.map((n) => `city.ilike.%${n}%`).join(','));

      if (cityError) throw cityError;

      const ids = (cityRestaurants ?? []).map((r) => r.id);
      if (ids.length === 0) {
        return ok({
          dishes: [],
          meta: {
            heading: `Viral dishes — ${city}`,
            rankedCount: 0,
            totalCount: 0,
            rankingUnavailable: true,
            note: `No restaurants in ${city} yet.`,
          },
        });
      }

      const { data: links, error: linkError } = await supabase
        .from('restaurant_dishes')
        .select('dish_id')
        .in('restaurant_id', ids);

      if (linkError) throw linkError;
      dishIdFilter = [...new Set((links ?? []).map((l) => l.dish_id))];

      if (dishIdFilter.length === 0) {
        return ok({
          dishes: [],
          meta: {
            heading: `Viral dishes — ${city}`,
            rankedCount: 0,
            totalCount: 0,
            rankingUnavailable: true,
            note: `No dishes recorded in ${city} yet.`,
          },
        });
      }
    }

    function base() {
      let query = supabase.from('dishes').select(DISH_COLUMNS);
      if (family) query = query.eq('family', family);
      if (category) query = query.eq('category', category);
      if (dishIdFilter) query = query.in('id', dishIdFilter);
      return query;
    }

    const { data: ranked, error: rankedError } = await base()
      .eq('trend_state', 'ranked')
      .order('trend_score', { ascending: false, nullsFirst: false })
      .limit(limit);

    if (rankedError) throw rankedError;

    const results = [...(ranked ?? [])];

    if (includeWarming || results.length < limit) {
      const { data: rest, error: restError } = await base()
        .neq('trend_state', 'ranked')
        .order('mention_count', { ascending: false })
        .order('restaurant_count', { ascending: false })
        .limit(limit - results.length);

      if (restError) throw restError;
      results.push(...(rest ?? []));
    }

    const dishes = results.map(presentDish);
    const rankedCount = dishes.filter((d) => d.trend.state === 'ranked').length;

    return ok({
      dishes,
      meta: {
        heading: `Viral dishes${city && city !== 'all' ? ` — ${city}` : ' — GTA'}`,
        scope: 'first_party_signals_only',
        windowDays: TREND_CONFIG.windowDays,
        minRestaurants: TREND_CONFIG.dishMinRestaurants,
        minMentions: TREND_CONFIG.dishMinMentions,
        rankedCount,
        totalCount: dishes.length,
        rankingUnavailable: rankedCount === 0,
        note:
          rankedCount === 0
            ? `No dish has reached ${TREND_CONFIG.dishMinRestaurants} restaurants and ${TREND_CONFIG.dishMinMentions} mentions yet, so nothing is ranked. Showing the most mentioned dishes instead.`
            : null,
      },
    });
  } catch (err) {
    return serverError(err, 'API/dishes');
  }
}
