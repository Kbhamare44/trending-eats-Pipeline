/**
 * Routes API — walking time for a pairing that has already been chosen.
 *
 * ── READ THIS BEFORE ADDING A SECOND CALLER ──
 *
 * The Routes API bills per ELEMENT. `computeRouteMatrix` over 5 origins and 5
 * destinations is 25 elements on one request, so using it to rank candidates
 * grows cost quadratically with the candidate set, for numbers that are only
 * used to sort.
 *
 * This module therefore exposes ONE function that takes ONE origin and ONE
 * destination: 1 element per call. Ranking happens on haversine distance in
 * lib/geo/distance.ts, which is free. If you find yourself wanting a matrix
 * here, the thing to question is the matrix, not this module.
 *
 * Every failure degrades to null and the caller falls back to an estimate
 * clearly labelled as one. A missing walking time must never fail a pairing.
 */

import { OUTING_CONFIG } from '@/lib/config/outings';
import type { LatLng } from '@/lib/geo/distance';

const COMPUTE_ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';

export interface WalkLeg {
  /** Walking minutes, rounded up — nobody is encouraged by an optimistic 7.4. */
  minutes: number;
  /** Walking distance along the route, in metres. */
  metres: number;
  /** False when this came from a straight-line estimate instead of Routes. */
  measured: boolean;
}

/**
 * Walking time between two points. One billed element.
 *
 * Returns null on any failure so the caller can estimate instead.
 */
export async function walkingLeg(
  origin: LatLng,
  destination: LatLng
): Promise<WalkLeg | null> {
  if (!OUTING_CONFIG.useRoutesApi) return null;

  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return null;

  try {
    const response = await fetch(COMPUTE_ROUTES, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        // The field mask is mandatory and is what you are billed for. Asking
        // only for duration and distance keeps this on the cheapest tier;
        // requesting polylines or legs would move it to a dearer one for
        // data a walking time does not need.
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
      },
      body: JSON.stringify({
        origin: { location: { latLng: origin } },
        destination: { location: { latLng: destination } },
        travelMode: 'WALK',
        // Walking routes do not vary by traffic, so no departure time and no
        // traffic-aware model — both would cost more for an identical answer.
        languageCode: 'en-CA',
        units: 'METRIC',
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.warn(
        `[Routes] computeRoutes ${response.status}: ${detail.slice(0, 160)}`
      );
      return null;
    }

    const body: any = await response.json();
    const route = body?.routes?.[0];
    if (!route) return null;

    // `duration` comes back as a protobuf duration string like "930s".
    const seconds = Number(String(route.duration ?? '').replace(/s$/, ''));
    const metres = Number(route.distanceMeters ?? 0);

    if (!Number.isFinite(seconds) || seconds <= 0) return null;

    return {
      minutes: Math.max(1, Math.ceil(seconds / 60)),
      metres: Number.isFinite(metres) ? metres : 0,
      measured: true,
    };
  } catch (err: any) {
    console.warn(`[Routes] walking leg failed: ${err?.message ?? err}`);
    return null;
  }
}
