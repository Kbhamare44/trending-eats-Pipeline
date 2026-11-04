/**
 * GET /api/cities
 *
 * Drives the Local Discovery filter. Returns the GTA cities we cover with a
 * live count of how many restaurants we actually have in each, so the app can
 * avoid offering a filter that leads to an empty list.
 */

import { supabase } from '@/lib/supabase/client';
import { GTA_CITIES, GTA_CENTER, resolveGtaCity } from '@/lib/geo/gta';
import { ok, serverError } from '@/lib/http/respond';

export async function GET() {
  try {
    const { data, error } = await supabase
      .from('restaurants')
      .select('city, address, is_gta, region');

    if (error) throw error;

    const counts = new Map<string, number>();
    let outOfMarket = 0;

    for (const row of data ?? []) {
      const resolved = resolveGtaCity(row.city, row.address);
      if (!resolved) {
        outOfMarket++;
        continue;
      }
      counts.set(resolved.name, (counts.get(resolved.name) ?? 0) + 1);
    }

    const cities = [...new Set(GTA_CITIES.map((c) => c.name))]
      .map((name) => {
        const city = GTA_CITIES.find((c) => c.name === name)!;
        return {
          name,
          region: city.region,
          center: city.center,
          restaurantCount: counts.get(name) ?? 0,
        };
      })
      .sort((a, b) => b.restaurantCount - a.restaurantCount || a.name.localeCompare(b.name));

    const regions = [...new Set(GTA_CITIES.map((c) => c.region))].map((region) => ({
      region,
      restaurantCount: cities
        .filter((c) => c.region === region)
        .reduce((sum, c) => sum + c.restaurantCount, 0),
    }));

    return ok({
      cities,
      regions,
      center: GTA_CENTER,
      meta: {
        market: 'Toronto & GTA',
        covered: cities.filter((c) => c.restaurantCount > 0).length,
        outOfMarketCount: outOfMarket,
      },
    });
  } catch (err) {
    return serverError(err, 'API/cities');
  }
}
