import axios from 'axios';
import { PlaceResult } from '@/lib/types';

const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';

// Search for a restaurant by name and city
// Returns the best matching result or null if nothing found
export async function findRestaurant(
  name: string,
  city: string
): Promise<PlaceResult | null> {
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    throw new Error('GOOGLE_PLACES_API_KEY is required');
  }

  const query = `${name} restaurant ${city}`;

  try {
    // Step 1: Text search to find the restaurant
    const searchResponse = await axios.get(`${PLACES_BASE}/textsearch/json`, {
      params: {
        query,
        type: 'restaurant',
        key: process.env.GOOGLE_PLACES_API_KEY,
      },
      timeout: 8000,
    });

    const results = searchResponse.data.results;
    if (!results || results.length === 0) {
      console.log(`No Google Places results for: ${query}`);
      return null;
    }

    // Take the top result
    const topResult = results[0];
    const placeId = topResult.place_id;

    // Step 2: Get detailed information for the top result
    const detailsResponse = await axios.get(`${PLACES_BASE}/details/json`, {
      params: {
        place_id: placeId,
        fields: [
          'name',
          'formatted_address',
          'geometry',
          'formatted_phone_number',
          'website',
          'rating',
          'price_level',
          'address_components',
        ].join(','),
        key: process.env.GOOGLE_PLACES_API_KEY,
      },
      timeout: 8000,
    });

    const details = detailsResponse.data.result;
    if (!details) return null;

    // Extract city from address components
    const cityComponent = details.address_components?.find(
      (c: any) => c.types.includes('locality')
    );
    const extractedCity =
      cityComponent?.long_name || city;

    return {
      placeId,
      name: details.name,
      address: details.formatted_address || '',
      city: extractedCity,
      latitude: details.geometry?.location?.lat || 0,
      longitude: details.geometry?.location?.lng || 0,
      phone: details.formatted_phone_number || null,
      website: details.website || null,
      googleRating: details.rating || null,
      priceLevel: details.price_level || null,
    };
  } catch (error: any) {
    console.error(`Google Places lookup failed for "${name}":`, error.message);
    return null;
  }
}

// Check if a restaurant already exists in Supabase by Place ID
// Use this before creating a new restaurant to prevent duplicates
export function buildPlaceSearchQuery(name: string, city: string): string {
  return `${name} ${city}`;
}