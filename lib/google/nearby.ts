/**
 * Places Nearby Search — finding something to do near a restaurant.
 *
 * Supports both API generations behind GOOGLE_PLACES_API_VERSION, matching
 * lib/google/places.ts: the legacy endpoints are closed to new Google Cloud
 * projects, so which one works depends on when the project was created.
 *
 * ── PLACES TERMS ──
 *
 * `place_id` may be cached indefinitely; other fields may not be retained
 * beyond 30 days. `activities.refreshed_at` records when each row was pulled
 * so stale ones are re-queried rather than served from an old cache, the same
 * pattern restaurants use.
 */

import { OUTING_CONFIG } from '@/lib/config/outings';

const LEGACY_NEARBY = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
const NEW_NEARBY = 'https://places.googleapis.com/v1/places:searchNearby';

function useNewApi(): boolean {
  return (process.env.GOOGLE_PLACES_API_VERSION ?? 'legacy') === 'new';
}

function apiKey(): string {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('GOOGLE_PLACES_API_KEY is not set');
  return key;
}

export interface NearbyActivity {
  placeId: string;
  name: string;
  category: string;
  address: string | null;
  latitude: number;
  longitude: number;
  googleRating: number | null;
  googleRatingCount: number | null;
  priceLevel: number | null;
  openingHours: unknown | null;
  /** Attribution strings that must be shown wherever this data appears. */
  attribution: string[];
  fetchedAt: string;
}

/** Google's price level enum (new API) to the 0-4 integer the schema uses. */
function priceLevelToInt(value: unknown): number | null {
  if (typeof value === 'number') return value;
  const map: Record<string, number> = {
    PRICE_LEVEL_FREE: 0,
    PRICE_LEVEL_INEXPENSIVE: 1,
    PRICE_LEVEL_MODERATE: 2,
    PRICE_LEVEL_EXPENSIVE: 3,
    PRICE_LEVEL_VERY_EXPENSIVE: 4,
  };
  return typeof value === 'string' ? (map[value] ?? null) : null;
}

async function searchLegacy(
  latitude: number,
  longitude: number,
  category: string
): Promise<NearbyActivity[]> {
  const params = new URLSearchParams({
    location: `${latitude},${longitude}`,
    radius: String(OUTING_CONFIG.searchRadiusM),
    type: category,
    key: apiKey(),
  });

  const response = await fetch(`${LEGACY_NEARBY}?${params.toString()}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const body: any = await response.json().catch(() => null);

  // Throw on a non-OK status rather than returning nothing. Reporting
  // REQUEST_DENIED as "no activities nearby" is the same mistake the
  // restaurant lookup used to make, and it hides a billing or key problem
  // behind what looks like a quiet neighbourhood.
  const status = body?.status;
  if (status && status !== 'OK' && status !== 'ZERO_RESULTS') {
    throw new Error(
      `Places nearby search failed: ${status}${body?.error_message ? ` — ${body.error_message}` : ''}`
    );
  }

  const now = new Date().toISOString();
  return (body?.results ?? [])
    .filter((r: any) => r.business_status !== 'CLOSED_PERMANENTLY')
    .map((r: any) => ({
      placeId: r.place_id,
      name: r.name,
      category,
      address: r.vicinity ?? null,
      latitude: r.geometry?.location?.lat,
      longitude: r.geometry?.location?.lng,
      googleRating: r.rating ?? null,
      googleRatingCount: r.user_ratings_total ?? null,
      priceLevel: priceLevelToInt(r.price_level),
      openingHours: r.opening_hours ?? null,
      attribution: r.html_attributions ?? [],
      fetchedAt: now,
    }))
    .filter((a: NearbyActivity) => a.placeId && a.latitude != null && a.longitude != null);
}

async function searchNew(
  latitude: number,
  longitude: number,
  category: string
): Promise<NearbyActivity[]> {
  const response = await fetch(NEW_NEARBY, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey(),
      // Field mask is mandatory on the new API and is what you are billed
      // for. Only what an activity row and a pairing actually need.
      'X-Goog-FieldMask': [
        'places.id',
        'places.displayName',
        'places.formattedAddress',
        'places.location',
        'places.rating',
        'places.userRatingCount',
        'places.priceLevel',
        'places.regularOpeningHours',
        'places.businessStatus',
      ].join(','),
    },
    body: JSON.stringify({
      includedTypes: [category],
      maxResultCount: 20,
      locationRestriction: {
        circle: {
          center: { latitude, longitude },
          radius: OUTING_CONFIG.searchRadiusM,
        },
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Places nearby search failed (${response.status}): ${detail.slice(0, 200)}`
    );
  }

  const body: any = await response.json();
  const now = new Date().toISOString();

  return (body?.places ?? [])
    .filter((p: any) => p.businessStatus !== 'CLOSED_PERMANENTLY')
    .map((p: any) => ({
      placeId: p.id,
      name: p.displayName?.text ?? '',
      category,
      address: p.formattedAddress ?? null,
      latitude: p.location?.latitude,
      longitude: p.location?.longitude,
      googleRating: p.rating ?? null,
      googleRatingCount: p.userRatingCount ?? null,
      priceLevel: priceLevelToInt(p.priceLevel),
      openingHours: p.regularOpeningHours ?? null,
      attribution: [],
      fetchedAt: now,
    }))
    .filter((a: NearbyActivity) => a.placeId && a.latitude != null && a.longitude != null);
}

/**
 * Activities near a point.
 *
 * One Places request PER CATEGORY, so the category list is a direct multiplier
 * on cost. Categories are tried in order and the search stops as soon as
 * enough candidates are found, which keeps the common case to one request.
 */
export async function findNearbyActivities(
  latitude: number,
  longitude: number,
  options: { categories?: string[]; enough?: number } = {}
): Promise<NearbyActivity[]> {
  const categories = options.categories ?? OUTING_CONFIG.categories;
  const enough = options.enough ?? OUTING_CONFIG.maxPairings * 3;

  const found: NearbyActivity[] = [];
  const seen = new Set<string>();

  for (const category of categories) {
    const batch = useNewApi()
      ? await searchNew(latitude, longitude, category)
      : await searchLegacy(latitude, longitude, category);

    for (const activity of batch) {
      if (seen.has(activity.placeId)) continue;

      // Quality gate before anything is stored or ranked. A trending
      // restaurant paired with a 2-star bar makes the app look careless, and
      // the thing people blame is the app.
      if (
        activity.googleRating != null &&
        activity.googleRating < OUTING_CONFIG.minActivityRating
      ) {
        continue;
      }
      if (
        activity.googleRatingCount != null &&
        activity.googleRatingCount < OUTING_CONFIG.minActivityRatingCount
      ) {
        continue;
      }

      seen.add(activity.placeId);
      found.push(activity);
    }

    if (found.length >= enough) break;
  }

  return found;
}
