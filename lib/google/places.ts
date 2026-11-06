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
import { PlaceResult, PlaceOption } from '@/lib/types';
import { GTA_CENTER, isGta, resolveGtaCity } from '@/lib/geo/gta';

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
  city: string,
  selectedPlaceId?: string | null
): Promise<PlaceLookupResult | null> {
  const query = `${name} ${city}`;
  const biasToGta = !city || isGta(city);

  const searchResponse = await axios.get(`${LEGACY_BASE}/textsearch/json`, {
    params: {
      query,
      // No `type: 'restaurant'` filter. Places does not classify a bakery,
      // cafe, dessert shop or bar as a restaurant, so that filter returned
      // zero results for "Bartholomew Bakery Vaughan" — a place already in
      // our own database — and would have rejected a large slice of exactly
      // what this app indexes. The name in the query is the constraint.
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
  if (!status) throw new Error('Places text search returned an invalid response');
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

  const selection = choosePlace(name, city, results.slice(0, 5).map((p: any) => ({
    placeId: p.place_id, name: p.name ?? '', address: p.formatted_address ?? '',
    city: (p.formatted_address ?? '').split(',').map((part: string) => part.trim()).at(-3) ?? '',
    types: p.types ?? [], businessStatus: p.business_status,
  })), selectedPlaceId);
  if (!selection) return null;
  if (!selection.locationVerified) return unconfirmedPlace(selection);
  const placeId = selection.chosen.placeId;

  const detailsResponse = await axios.get(`${LEGACY_BASE}/details/json`, {
    params: {
      place_id: placeId,
      fields: [
        'name',
        'types',
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
  const detailStatus = detailsResponse.data?.status;
  if (detailStatus && !['OK', 'NOT_FOUND', 'ZERO_RESULTS'].includes(detailStatus)) throw new Error(`Places details returned ${detailStatus}`);
  if (!details) return null;
  const checked = choosePlace(name, city, [{ placeId, name: details.name ?? '', address: details.formatted_address ?? '',
    city: cityFromComponents(details.address_components, ''), types: details.types ?? [], businessStatus: details.business_status }], selectedPlaceId);
  if (!checked) return null;
  if (!checked.locationVerified) return unconfirmedPlace(checked);
  if (typeof details.geometry?.location?.lat !== 'number' || typeof details.geometry?.location?.lng !== 'number') return null;

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
    ambiguous: false,
    locationVerified: true,
    candidates: checked.candidates,
    city: cityFromComponents(details.address_components, ''),
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
  city: string,
  selectedPlaceId?: string | null
): Promise<PlaceLookupResult | null> {
  const biasToGta = !city || isGta(city);

  const response = await axios.post(
    `${NEW_BASE}:searchText`,
    {
      textQuery: `${name} ${city}`,
      maxResultCount: 5,
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
          'places.types',
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

  const raw = response.data?.places ?? [];
  const selection = choosePlace(name, city, raw.map((p: any) => ({
    placeId: p.id, name: p.displayName?.text ?? '', address: p.formattedAddress ?? '',
    city: cityFromComponents(p.addressComponents?.map((c: any) => ({long_name:c.longText, types:c.types})), ''),
    types: p.types ?? [], businessStatus: p.businessStatus,
  })), selectedPlaceId);
  if (!selection) return null;
  if (!selection.locationVerified) return unconfirmedPlace(selection);
  const place = raw.find((p: any) => p.id === selection.chosen.placeId);
  if (typeof place.location?.latitude !== 'number' || typeof place.location?.longitude !== 'number') return null;

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
    city: cityFromComponents(components, ''),
    latitude: place.location?.latitude ?? 0,
    longitude: place.location?.longitude ?? 0,
    phone: place.nationalPhoneNumber ?? null,
    website: place.websiteUri ?? null,
    googleRating: place.rating ?? null,
    googleRatingCount: place.userRatingCount ?? null,
    priceLevel:
      place.priceLevel != null ? NEW_PRICE_LEVELS[place.priceLevel] ?? null : null,
    ambiguous: false,
    locationVerified: true,
    candidates: selection.candidates,
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
  city: string,
  selectedPlaceId?: string | null
): Promise<PlaceLookupResult | null> {
  for (const query of placeNameQueries(name)) {
    // A provider failure is retryable by the existing queue; it does not
    // mean that the restaurant does not exist. Never log Axios headers.
    const result = useNewApi() ? await findRestaurantNew(query, city, selectedPlaceId) : await findRestaurantLegacy(query, city, selectedPlaceId);
    if (result) return result;
  }
  return null;
}

const norm = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const FOOD_TYPES = new Set(['restaurant','cafe','bakery','bar','meal_takeaway','meal_delivery','coffee_shop','dessert_shop','ice_cream_shop','food_court']);
const GENERIC_WORDS = new Set(['the','and','s','restaurant','shawarma','shawerma','shwarma','pizza','bakery','cafe','grill','food','halal','inc','ltd']);
export interface SearchPlace extends PlaceOption { types: string[]; businessStatus?: string | null; }

function cityMatches(expected: string, place: PlaceOption): boolean {
  const known = resolveGtaCity(expected);
  if (known && norm(known.name) !== norm(expected)) return norm(place.city) === norm(expected) || (` ${norm(place.address)} `).includes(` ${norm(expected)} `);
  return norm(known?.name ?? expected) === norm(resolveGtaCity(place.city)?.name ?? place.city);
}

/** A result needs matching business-name words, a food type and location evidence. */
export function choosePlace(name: string, city: string, places: SearchPlace[], selectedPlaceId?: string | null) {
  const wanted = norm(name), distinctive = wanted.split(' ').filter(word => !GENERIC_WORDS.has(word));
  const eligible = [...new Map(places.filter(place => {
    const found = norm(place.name), words = new Set(found.split(' '));
    const nameMatches = Boolean(wanted) && (wanted.replace(/ /g,'') === found.replace(/ /g,'') || (distinctive.length > 0 && distinctive.every(word => words.has(word))));
    return nameMatches && place.types.some(type => FOOD_TYPES.has(type) || type.endsWith('_restaurant')) && (!place.businessStatus || place.businessStatus === 'OPERATIONAL');
  }).map(place => [place.placeId, place])).values()];
  const local = city ? eligible.filter(place => cityMatches(city, place)) : eligible;
  const options = local.length ? local : eligible;
  const chosen = selectedPlaceId ? options.find(place => place.placeId === selectedPlaceId) : options[0];
  if (!chosen) return null;
  const ambiguous = !selectedPlaceId && options.length > 1;
  return { chosen, ambiguous, locationVerified: !ambiguous && (!city || cityMatches(city, chosen)) && Boolean(city || selectedPlaceId),
    candidates: options.slice(0,5).map(({placeId,name,address,city}) => ({placeId,name,address,city})) };
}

function unconfirmedPlace(selection: NonNullable<ReturnType<typeof choosePlace>>): PlaceLookupResult {
  return { ...selection.chosen, ambiguous: selection.ambiguous, locationVerified: false, candidates: selection.candidates,
    latitude: 0, longitude: 0, phone: null, website: null, googleRating: null, googleRatingCount: null,
    priceLevel: null, attribution: [], fetchedAt: new Date().toISOString() };
}

/** Two justified forms at most: original and food-word spacing/spelling. */
export function placeNameQueries(name: string): string[] {
  const spaced = name.replace(/[_-]+/g, ' ').replace(/(\p{L})(?=(?:shawarma|shawerma|shwarma|pizza|bakery|cafe|grill)\b)/giu, '$1 ')
    .replace(/\b(?:shawerma|shwarma)\b/giu, 'shawarma').replace(/\s+/g,' ').trim();
  return [...new Set([name.trim(), spaced])].filter(Boolean).slice(0,2);
}

export function buildPlaceSearchQuery(name: string, city: string): string {
  return `${name} ${city}`.trim();
}
