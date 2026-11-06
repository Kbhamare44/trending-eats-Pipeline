/**
 * GET /api/restaurants/map — what to draw for one map viewport.
 *
 * Query: minLat, minLng, maxLat, maxLng, zoom, and optional city/gtaOnly.
 *
 * WHY THIS EXISTS: the map used to call /api/restaurants with limit=200 on
 * every city change. That fetches the full presented record — AI summary,
 * score breakdowns, dish lists — for every restaurant in the market whether
 * or not it is on screen, then filters by distance in JavaScript. There has
 * been a spatial index on (latitude, longitude) the whole time that nothing
 * used.
 *
 * Above MAP_PIN_ZOOM_THRESHOLD this returns individual pins, capped at
 * MAP_MAX_PINS because react-native-maps degrades past roughly a hundred
 * marker views. Below it, it returns cluster bubbles with counts — drawing
 * the whole GTA as individual pins is both slow and unreadable.
 *
 * The payload is deliberately minimal: what a pin needs to render and be
 * tapped, nothing more. The detail screen fetches the rest.
 *
 * /api/restaurants is unchanged and still backs the browse list.
 */

import type { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase/client';
import {
  MAP_CONFIG,
  clusterGridForZoom,
  parseBounds,
} from '@/lib/config/map';
import { ok, badRequest, serverError } from '@/lib/http/respond';

export interface MapPin {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  city: string | null;
  cuisineType: string | null;
  priceLevel: number | null;
  /** 'ranked' | 'warming_up' | 'insufficient_data' — drives pin colour. */
  trendState: string;
  isGta: boolean;
}

export interface MapCluster {
  /** Stable id so React can key it without reordering churn. */
  id: string;
  latitude: number;
  longitude: number;
  count: number;
  /** How many in this cell are actually ranked, for emphasis. */
  rankedCount: number;
}

function toPin(row: any): MapPin {
  return {
    id: row.id,
    name: row.name,
    latitude: row.latitude,
    longitude: row.longitude,
    city: row.city ?? null,
    cuisineType: row.cuisine_type ?? null,
    priceLevel: row.price_level ?? null,
    trendState: row.trend_state ?? 'insufficient_data',
    isGta: Boolean(row.is_gta),
  };
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;

    const bounds = parseBounds(params);
    if (!bounds) {
      return badRequest(
        'minLat, minLng, maxLat and maxLng are required and must describe a non-empty rectangle'
      );
    }

    const zoomRaw = Number(params.get('zoom'));
    // An absent or unparseable zoom means we cannot tell pins from clusters.
    // Assume pins: showing too much detail is a performance problem, showing
    // a cluster where a pin belongs is a correctness one.
    const zoom = Number.isFinite(zoomRaw) ? zoomRaw : MAP_CONFIG.pinZoomThreshold;

    const gtaOnly = params.get('gtaOnly') === 'true';

    // Cluster only when there is actually something to collapse.
    //
    // At GTA zoom the map was in cluster mode by zoom alone, so six
    // restaurants rendered as black "1" bubbles — a count bubble over a
    // single place, which cannot show what the place is and cannot be
    // tapped open. Clustering exists to stop a hundred markers choking
    // react-native-maps; below that it only destroys information.
    let mode = zoom >= MAP_CONFIG.pinZoomThreshold ? 'pins' : 'clusters';

    if (mode === 'clusters') {
      const { data: probe, error: probeError } = await supabase.rpc('te_restaurant_clusters', {
        min_lat: bounds.minLat,
        min_lng: bounds.minLng,
        max_lat: bounds.maxLat,
        max_lng: bounds.maxLng,
        grid_size: clusterGridForZoom(zoom),
        gta_only: gtaOnly,
      });
      if (!probeError) {
        const total = (probe ?? []).reduce((sum: number, r: any) => sum + Number(r.n ?? 0), 0);
        if (total <= MAP_CONFIG.maxPins) mode = 'pins';
      }
    }

    if (mode === 'clusters') {
      const grid = clusterGridForZoom(zoom);
      const { data, error } = await supabase.rpc('te_restaurant_clusters', {
        min_lat: bounds.minLat,
        min_lng: bounds.minLng,
        max_lat: bounds.maxLat,
        max_lng: bounds.maxLng,
        grid_size: grid,
        gta_only: gtaOnly,
      });

      if (error) throw new Error(`te_restaurant_clusters failed: ${error.message}`);

      const clusters: MapCluster[] = (data ?? []).map((row: any) => ({
        id: `c:${row.cell_lat}:${row.cell_lng}`,
        latitude: Number(row.cell_lat),
        longitude: Number(row.cell_lng),
        count: Number(row.n ?? 0),
        rankedCount: Number(row.ranked_n ?? 0),
      }));

      return ok({
        mode,
        pins: [],
        clusters,
        meta: {
          zoom,
          gridSize: grid,
          clusterCount: clusters.length,
          restaurantCount: clusters.reduce((sum, c) => sum + c.count, 0),
          truncated: false,
        },
      });
    }

    const { data, error } = await supabase.rpc('te_restaurants_in_bounds', {
      min_lat: bounds.minLat,
      min_lng: bounds.minLng,
      max_lat: bounds.maxLat,
      max_lng: bounds.maxLng,
      max_results: MAP_CONFIG.maxPins,
      gta_only: gtaOnly,
    });

    if (error) throw new Error(`te_restaurants_in_bounds failed: ${error.message}`);

    const rows = data ?? [];
    const pins = rows.map(toPin);

    return ok({
      mode,
      pins,
      clusters: [],
      meta: {
        zoom,
        pinCount: pins.length,
        maxPins: MAP_CONFIG.maxPins,
        // The client shows a hint when the viewport held more than it can
        // draw, so "some places are missing" is explained rather than a bug.
        truncated: pins.length >= MAP_CONFIG.maxPins,
      },
    });
  } catch (err) {
    return serverError(err, 'API/restaurants/map');
  }
}
