/**
 * Google Places lookup — verifies that a restaurant Gemini pulled out of a
 * caption is a real, findable business before we create a listing for it.
 *
 * Terms of use that this file is written around:
 *  - `place_id` may be cached indefinitely; other Places fields may not be
 *    retained beyond 30 days. `google_data_refreshed_at` records when we last
 *    pulled, so a cleanup job can refresh or clear stale fields.
 *  - Any displayed Google content must be attributed. The API response carries
 *    `attribution` strings for the client to render.
 *
 * Two API generations are supported. The legacy Text Search / Details
 * endpoints are closed to new Google Cloud customers, so if your key is newer
 * than that cutoff, set GOOGLE_PLACES_API_VERSION=new.
 */

import axios from 'axios';
import { PlaceResult } from '@/lib/types';
import { GTA_CENTER, isGta } from '@/lib/geo/gta';

const LEGACY_BASE = 'https://maps.googleapis.com/maps/api/place';
const NEW_BASE = 'https://places.googleapis.com/v1/places';

/** Bias radius around the GTA centre, metres. ~55km covers Hamilton to Oshawa. */
const GTA_BIAS_RADIUS_M = 55_000;

function apiKey(): string {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('GOOGLE_PLACES_API_KEY is required');
  return key;
}

function useNewApi(): boolean {
  return (process.env.GOOGLE_PLACES_API_VERSION ?? 'legacy') === 'new';
}

export interface PlaceLookupResult extends PlaceResult {
  googleRatingCount: number | null;
  /** Strings Google requires us to display alongside its data. */
  attribution: string[];
  fetchedAt: string;
}

function cityFromComponents(components: any[], fallback: string): string {
  const byType = (type: string) =>
    components?.find((c: any) => c.types?.includes(type))?.long_name;

  return (
    byType('locality') ||
    byType('postal_town') ||
    byType('administrative_area_level_3') ||
    byType('sublocality') ||
    fallback
  );
}

// ── Legacy Text Search + Details ────────────────────────────────────────────

async function findRestaurantLegacy(
  name: string,
  city: string
): Promise<PlaceLookupResult | null> {
  const query = `${name} ${city}`;
  const biasToGta = isGta(city);

  const searchResponse = await axios.get(`${LEGACY_BASE}/textsearch/json`, {
    params: {
      query,
      type: 'restaurant',
      region: 'ca',
      ...(biasToGta
        ? {
            location: `${GTA_CENTER.latitude},${GTA_CENTER.longitude}`,
            radius: GTA_BIAS_RADIUS_M,
          }
        : {}),
      key: apiKey(),
    },
    timeout: 8000,
  });

  const status = searchResponse.data?.status;
  if (status && status !== 'OK' && status !== 'ZERO_RESULTS') {
    // Surfacing this matters: REQUEST_DENIED here is how a disabled legacy API
    // or an unbilled project presents, and silently returning null made it
    // look like "no restaurant found".
    throw new Error(
      `Places text search returned ${status}${
        searchResponse.data?.error_message
          ? `: ${searchResponse.data.error_message}`
          : ''
      }`
    );
  }

  const results = searchResponse.data?.results;
  if (!results || results.length === 0) return null;

  const placeId = results[0].place_id;
  // Same name on a second result means we are looking at a chain and cannot
  // tell which branch the video meant from the name alone.
  const ambiguous = sameNamedRival(results[0]?.name, results[1]?.name);

  const detailsResponse = await axios.get(`${LEGACY_BASE}/details/json`, {
    params: {
      place_id: placeId,
      fields: [
        'name',
        'formatted_address',
        'geometry',
        'formatted_phone_number',
        'website',
        'rating',
        'user_ratings_total',
        'price_level',
        'address_components',
        'business_status',
      ].join(','),
      key: apiKey(),
    },
    timeout: 8000,
  });

  const details = detailsResponse.data?.result;
  if (!details) return null;

  // Do not create listings for places Google says are gone.
  if (details.business_status && details.business_status !== 'OPERATIONAL') {
    console.log(
      `[Places] Skipping "${name}": business_status = ${details.business_status}`
    );
    return null;
  }

  return {
    placeId,
    name: details.name,
    address: details.formatted_address || '',
    city: cityFromComponents(details.address_components, city),
    latitude: details.geometry?.location?.lat ?? 0,
    longitude: details.geometry?.location?.lng ?? 0,
    phone: details.formatted_phone_number || null,
    website: details.website || null,
    googleRating: details.rating ?? null,
    googleRatingCount: details.user_ratings_total ?? null,
    priceLevel: details.price_level ?? null,
    attribution:
      details.rating != null ? ['Ratings and place details from Google'] : [],
    fetchedAt: new Date().toISOString(),
  };
}

// ── Places API (New) ────────────────────────────────────────────────────────

const NEW_PRICE_LEVELS: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

async function findRestaurantNew(
  name: string,
  city: string
): Promise<PlaceLookupResult | null> {
  const biasToGta = isGta(city);

  const response = await axios.post(
    `${NEW_BASE}:searchText`,
    {
      textQuery: `${name} ${city}`,
      includedType: 'restaurant',
      maxResultCount: 1,
      regionCode: 'CA',
      ...(biasToGta
        ? {
            locationBias: {
              circle: {
                center: {
                  latitude: GTA_CENTER.latitude,
                  longitude: GTA_CENTER.longitude,
                },
                radius: GTA_BIAS_RADIUS_M,
              },
            },
          }
        : {}),
    },
    {
      timeout: 8000,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey(),
        // The new API bills by requested field, so ask for exactly what we store.
        'X-Goog-FieldMask': [
          'places.id',
          'places.displayName',
          'places.formattedAddress',
          'places.location',
          'places.nationalPhoneNumber',
          'places.websiteUri',
          'places.rating',
          'places.userRatingCount',
          'places.priceLevel',
          'places.businessStatus',
          'places.addressComponents',
        ].join(','),
      },
    }
  );

  const place = response.data?.places?.[0];
  if (!place) return null;
  const ambiguous = sameNamedRival(
    place.displayName?.text,
    response.data?.places?.[1]?.displayName?.text
  );

  if (place.businessStatus && place.businessStatus !== 'OPERATIONAL') {
    console.log(
      `[Places] Skipping "${name}": businessStatus = ${place.businessStatus}`
    );
    return null;
  }

  const components = (place.addressComponents ?? []).map((c: any) => ({
    long_name: c.longText,
    types: c.types,
  }));

  return {
    placeId: place.id,
    name: place.displayName?.text ?? name,
    address: place.formattedAddress ?? '',
    city: cityFromComponents(components, city),
    latitude: place.location?.latitude ?? 0,
    longitude: place.location?.longitude ?? 0,
    phone: place.nationalPhoneNumber ?? null,
    website: place.websiteUri ?? null,
    googleRating: place.rating ?? null,
    googleRatingCount: place.userRatingCount ?? null,
    priceLevel:
      place.priceLevel != null ? NEW_PRICE_LEVELS[place.priceLevel] ?? null : null,
    ambiguous,
    attribution:
      place.rating != null ? ['Ratings and place details from Google'] : [],
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Find the best Google Places match for a restaurant name in a city.
 * Returns null when nothing matches; throws when the API itself is misconfigured,
 * so a billing or key problem is not silently reported as "restaurant not found".
 */
export async function findRestaurant(
  name: string,
  city: string
): Promise<PlaceLookupResult | null> {
  try {
    return useNewApi()
      ? await findRestaurantNew(name, city)
      : await findRestaurantLegacy(name, city);
  } catch (error: any) {
    const detail =
      error.response?.data?.error?.message ||
      error.response?.data?.error_message ||
      error.message;

    // A 403 from the legacy endpoints usually means the legacy Places API is
    // not enabled on this key. Point at the fix rather than swallowing it.
    if (error.response?.status === 403 && !useNewApi()) {
      console.error(
        `[Places] 403 on the legacy API for "${name}". If this Google Cloud ` +
          `project was created after the legacy Places cutoff, set ` +
          `GOOGLE_PLACES_API_VERSION=new. Detail: ${detail}`
      );
    } else {
      console.error(`[Places] Lookup failed for "${name}": ${detail}`);
    }
    return null;
  }
}

/** Two results with the same name are two branches of one business. */
function sameNamedRival(first?: string, second?: string): boolean {
  if (!first || !second) return false;
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return norm(first) === norm(second);
}

export function buildPlaceSearchQuery(name: string, city: string): string {
  return `${name} ${city}`;
}
