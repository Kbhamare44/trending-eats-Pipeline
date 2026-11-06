/**
 * GET /api/outings — suggested pairings: a restaurant, something to do
 * nearby, and the walk between them.
 *
 * Query: city (optional, 'all' or a GTA city name), limit (capped).
 *
 * COST: one Places Nearby request per restaurant considered, and at most
 * `limit` Routes elements — one per returned pairing, never per candidate.
 * `meta.routesCalled` reports the actual number so spend is observable from
 * the response rather than only from the bill.
 *
 * Rate limited: this is the most expensive read in the API.
 */

import type { NextRequest } from 'next/server';
import { buildPairings } from '@/lib/outings/pair';
import { OUTING_CONFIG } from '@/lib/config/outings';
import { getAuthedUser } from '@/lib/auth/verify';
import { inMemoryLimit, clientKey, tooManyRequests } from '@/lib/http/ratelimit';
import { ok, serverError, intParam } from '@/lib/http/respond';

/** Nearby search plus a Routes call per pairing. */
export const maxDuration = 60;

/**
 * Lower than the other read endpoints because each call spends Google money.
 * In-memory, so best effort — see lib/http/ratelimit.ts.
 */
const PER_MINUTE = 10;

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthedUser(request);

    const limit = inMemoryLimit(
      `outings:${clientKey(request, user?.id)}`,
      PER_MINUTE,
      60_000
    );
    if (!limit.allowed) {
      return tooManyRequests('Give us a moment.', limit.retryAfterSeconds);
    }

    const params = request.nextUrl.searchParams;
    const city = params.get('city');
    const count = intParam(params.get('limit'), OUTING_CONFIG.maxPairings, OUTING_CONFIG.maxPairings);
    const restaurantId = params.get('restaurantId');
    const mode = params.get('mode') === 'drive' ? 'drive' : 'walk';
    const maxMinutes = params.get('maxMinutes') ? Number(params.get('maxMinutes')) : null;

    const result = await buildPairings({
      city,
      limit: restaurantId ? 1 : count,
      restaurantId,
      mode,
      maxMinutes: Number.isFinite(maxMinutes as number) ? maxMinutes : null,
    });

    return ok({
      pairings: result.pairings,
      meta: {
        ...result.meta,
        // Render-ready, so the client never has to decide what to claim.
        heading:
          result.meta.basis === 'ranked'
            ? 'Trending, and something to do after'
            : 'Somewhere to eat, and something to do after',
        city: city ?? 'all',
        mode,
        maxMinutes,
        // Required wherever Google-sourced data is displayed.
        attribution: 'Activity details and ratings from Google',
      },
    });
  } catch (err) {
    return serverError(err, 'API/outings');
  }
}
