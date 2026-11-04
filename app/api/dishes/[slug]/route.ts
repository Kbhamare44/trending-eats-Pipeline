/**
 * GET /api/dishes/:slug
 *
 * One dish, plus every restaurant we know serves it — the "where can I get
 * this" screen.
 */

import type { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase/client';
import {
  presentDish,
  presentRestaurant,
  RESTAURANT_COLUMNS,
} from '@/lib/presenters/restaurant';
import { ok, notFound, serverError } from '@/lib/http/respond';
import { resolveGtaCity } from '@/lib/geo/gta';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;
    const city = request.nextUrl.searchParams.get('city');

    const { data: dish, error: dishError } = await supabase
      .from('dishes')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();

    if (dishError) throw dishError;
    if (!dish) return notFound('Dish not found');

    const { data: links, error: linkError } = await supabase
      .from('restaurant_dishes')
      .select('restaurant_id, mention_count, review_count, avg_sentiment, last_seen')
      .eq('dish_id', dish.id)
      .order('mention_count', { ascending: false })
      .limit(60);

    if (linkError) throw linkError;

    const restaurantIds = (links ?? []).map((l) => l.restaurant_id);
    let restaurants: any[] = [];

    if (restaurantIds.length > 0) {
      let query = supabase
        .from('restaurants')
        .select(RESTAURANT_COLUMNS)
        .in('id', restaurantIds);

      if (city && city !== 'all') {
        const resolved = resolveGtaCity(city);
        const names = resolved ? [resolved.name, ...resolved.aliases] : [city];
        query = query.or(names.map((n) => `city.ilike.%${n}%`).join(','));
      }

      const { data, error } = await query;
      if (error) throw error;
      restaurants = data ?? [];
    }

    const mentionsById = new Map(
      (links ?? []).map((l) => [l.restaurant_id, l])
    );

    // Order restaurants by how much this specific dish is mentioned there,
    // not by the restaurant's own trend score.
    const presented = restaurants
      .map((row) => ({
        ...presentRestaurant(row),
        dishMentions: mentionsById.get(row.id)?.mention_count ?? 0,
        dishReviewCount: mentionsById.get(row.id)?.review_count ?? 0,
      }))
      .sort((a, b) => b.dishMentions - a.dishMentions);

    // Sibling dishes in the same family: "other matcha things".
    let related: any[] = [];
    if (dish.family) {
      const { data: siblings } = await supabase
        .from('dishes')
        .select('*')
        .eq('family', dish.family)
        .neq('id', dish.id)
        .order('mention_count', { ascending: false })
        .limit(8);
      related = (siblings ?? []).map(presentDish);
    }

    return ok({
      dish: presentDish(dish),
      restaurants: presented,
      related,
      meta: {
        scope: 'first_party_signals_only',
        restaurantCount: presented.length,
      },
    });
  } catch (err) {
    return serverError(err, 'API/dishes/[slug]');
  }
}
