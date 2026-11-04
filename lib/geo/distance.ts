/**
 * Straight-line distance.
 *
 * This is what ranks candidate pairings, instead of the Routes API. Routes
 * prices per element, so scoring every restaurant against every nearby
 * activity through it bills quadratically for information that is only used
 * to sort. Haversine is free, runs locally, and orders candidates correctly
 * — walking distance is monotonic in straight-line distance often enough for
 * a ranking, even though it is always longer.
 */

export interface LatLng {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_M = 6_371_000;

export function haversineMetres(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A walking-time estimate from straight-line distance.
 *
 * Only used when Routes is unavailable or switched off, and always surfaced
 * as an estimate. It is optimistic by construction: the real route is longer
 * than the straight line, never shorter.
 */
export function estimateWalkMinutes(metres: number, metresPerMinute: number): number {
  if (metres <= 0) return 0;
  return Math.max(1, Math.round(metres / metresPerMinute));
}
