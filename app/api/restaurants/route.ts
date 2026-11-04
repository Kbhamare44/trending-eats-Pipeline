/**
 * GET /api/restaurants
 *
 * The map and browse list. Supports GTA city/region scoping, cuisine filters,
 * radius search, and an explicit sort.
 *
 * Breaking change from the previous version: the response is now
 * `{ restaurants, meta }` rather than a bare array, and sorting by
 * `authenticity` no longer ranks no-data rows above measured ones. The mobile
 * client in this repo's sibling app has been updated to match.
 */

import type { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase/client';
import {
  presentRestaurant,
  RESTAURANT_COLUMNS,
} from '@/lib/presenters/restaurant';
import { ok, serverError, intParam } from '@/lib/http/respond';
import { resolveGtaCity } from '@/lib/geo/gta';

/** Haversine distance in km. */
function distanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const city = params.get('city');
    const region = params.get('region');
    const cuisine = params.get('cuisine');
    const search = params.get('q');
    const gtaOnly = params.get('gtaOnly') === 'true';
    const sort = params.get('sort') ?? 'trend';
    const limit = intParam(params.get('limit'), 50, 200);
    const lat = params.get('lat') ? Number(params.get('lat')) : null;
    const lng = params.get('lng') ? Number(params.get('lng')) : null;
    const radiusKm = params.get('radiusKm') ? Number(params.get('radiusKm')) : 15;

    let query = supabase.from('restaurants').select(RESTAURANT_COLUMNS);

    if (gtaOnly) query = query.eq('is_gta', true);
    if (region) query = query.eq('region', region);
    if (cuisine) query = query.ilike('cuisine_type', `%${cuisine}%`);
    if (search) query = query.ilike('name', `%${search}%`);

    if (city && city !== 'all') {
      const resolved = resolveGtaCity(city);
      const names = resolved ? [resolved.name, ...resolved.aliases] : [city];
      query = query.or(names.map((n) => `city.ilike.%${n}%`).join(','));
    }

    switch (sort) {
      case 'trend':
        // nullsFirst: false matters — a null trend_score means "not ranked",
        // and those must sort last rather than to the top.
        query = query
          .order('trend_score', { ascending: false, nullsFirst: false })
          .order('review_count', { ascending: false });
        break;
      case 'experience':
        query = query
          .order('experience_score', { ascending: false, nullsFirst: false })
          .order('experience_observations', { ascending: false });
        break;
      case 'reviews':
        query = query.order('review_count', { ascending: false });
        break;
      case 'saves':
        query = query.order('saves_count', { ascending: false });
        break;
      case 'recent':
      default:
        query = query.order('created_at', { ascending: false });
        break;
    }

    const { data, error } = await query.limit(limit);
    if (error) throw error;

    let restaurants = (data ?? []).map(presentRestaurant);

    // Radius filter in application code: the rows are few and this avoids a
    // PostGIS dependency. Revisit if the table grows past a few thousand.
    if (lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng)) {
      restaurants = restaurants
        .map((r) => ({
          ...r,
          distanceKm:
            r.latitude !== null && r.longitude !== null
              ? Math.round(distanceKm(lat, lng, r.latitude, r.longitude) * 10) / 10
              : null,
        }))
        .filter((r) => r.distanceKm !== null && r.distanceKm <= radiusKm)
        .sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0)) as typeof restaurants;
    }

    return ok({
      restaurants,
      meta: {
        count: restaurants.length,
        sort,
        city: city ?? null,
        region: region ?? null,
        gtaOnly,
      },
    });
  } catch (err) {
    return serverError(err, 'API/restaurants');
  }
}
