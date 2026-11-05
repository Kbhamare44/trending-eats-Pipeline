import { OUTING_CONFIG } from '@/lib/config/outings';

const RECREATION: Record<string, { category: string; label: string; relevance: number }> = {
  movie_theater: { category: 'movie_theater', label: 'Cinema', relevance: 9 },
  museum: { category: 'museum', label: 'Museum', relevance: 9 },
  art_gallery: { category: 'art_gallery', label: 'Art gallery', relevance: 8 },
  bowling_alley: { category: 'bowling_alley', label: 'Bowling', relevance: 9 },
  park: { category: 'park', label: 'Park', relevance: 8 },
  national_park: { category: 'park', label: 'Public park', relevance: 8 },
  hiking_area: { category: 'park', label: 'Walking area', relevance: 8 },
  amusement_park: { category: 'amusement_park', label: 'Amusement park', relevance: 8 },
  amusement_center: { category: 'amusement_park', label: 'Recreation centre', relevance: 8 },
  tourist_attraction: { category: 'tourist_attraction', label: 'Attraction', relevance: 6 },
  zoo: { category: 'zoo', label: 'Zoo', relevance: 8 },
  aquarium: { category: 'aquarium', label: 'Aquarium', relevance: 8 },
};
const EXCLUDED = new Set(['electronics_store', 'car_dealer', 'car_rental', 'car_repair', 'car_wash', 'corporate_office', 'storage', 'warehouse', 'real_estate_agency', 'insurance_agency', 'bank', 'gas_station', 'furniture_store', 'hardware_store', 'home_goods_store', 'department_store', 'shopping_mall', 'supermarket', 'wholesaler']);

export interface ActivityEvidence {
  name: string;
  types: string[];
  primaryType?: string | null;
  businessStatus?: string | null;
  googleRating: number | null;
  googleRatingCount: number | null;
}

/** Actual provider types establish relevance; a search category is never evidence. */
export function activityQuality(activity: ActivityEvidence) {
  const types = [activity.primaryType, ...activity.types].filter((type): type is string => Boolean(type));
  if (types.some(type => EXCLUDED.has(type))) return null;
  if (activity.businessStatus && activity.businessStatus !== 'OPERATIONAL') return null;
  let recreation = types.map(type => RECREATION[type]).find(Boolean);
  // Legacy has no separate mini-golf search type. Require recreational metadata
  // as well as an explicit mini-golf name; an ordinary retail name cannot pass.
  if ((recreation || types.includes('golf_course')) && /mini[ -]?golf|putt[ -]?putt/i.test(activity.name)) {
    recreation = { category: 'mini_golf', label: 'Mini golf', relevance: 10 };
  }
  if (!recreation) return null;
  const rating = activity.googleRating;
  const count = activity.googleRatingCount;
  if (rating != null && count != null && count >= OUTING_CONFIG.minActivityRatingCount && rating < OUTING_CONFIG.minActivityRating) return null;
  const confidence = count == null ? 0 : count / (count + 50);
  const ratingBonus = rating == null ? 0 : (rating - 3.5) * confidence * 4;
  return { ...recreation, ratingBonus };
}

export function activityScore(activity: ActivityEvidence, metres: number, categoryRepeated = false) {
  const quality = activityQuality(activity);
  return quality ? quality.relevance * 2 + quality.ratingBonus - metres / 100 - (categoryRepeated ? 6 : 0) : -Infinity;
}

export function activityReason(activity: ActivityEvidence, walkingMinutes: number, measured: boolean) {
  const quality = activityQuality(activity);
  const rating = activity.googleRating == null ? 'Google rating unavailable' : `${activity.googleRating}/5${activity.googleRatingCount == null ? ' on Google' : ` from ${activity.googleRatingCount} Google reviews`}`;
  return `${quality?.label ?? 'Activity'} · ${rating} · ${measured ? '' : 'about '}${walkingMinutes} min walk${measured ? '' : ' (estimated)'}`;
}
