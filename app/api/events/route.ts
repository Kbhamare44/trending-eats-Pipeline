/**
 * POST /api/events
 *
 * First-party engagement from the app: a restaurant page opened, a dish
 * browsed, a search run. Feeds the unique-engagement and recency components
 * of the Trend Score.
 *
 * Privacy: signed-in events store the verified user id from the bearer token.
 * Signed-out events store only `anonId`, an opaque per-install value we never
 * resolve to a person. The body's own `userId` is ignored entirely — that is
 * the spoofing hole the older routes left open.
 */

import type { NextRequest } from 'next/server';
import { getAuthedUser } from '@/lib/auth/verify';
import { recordEvent, isClientEventType } from '@/lib/trends/events';
import { ok, badRequest, serverError } from '@/lib/http/respond';
import { inMemoryLimit, clientKey, LIMITS, tooManyRequests } from '@/lib/http/ratelimit';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return badRequest('A JSON body is required');
    }

    const { eventType, restaurantId, dishId, anonId, city } = body as Record<
      string,
      unknown
    >;

    if (!isClientEventType(eventType)) {
      return badRequest(
        'eventType must be one of: restaurant_view, restaurant_detail_view, dish_view, search'
      );
    }

    const user = await getAuthedUser(request);

    // An event is one cheap insert, but unbounded inserts still fill the
    // table that every trend score reads. In-memory and therefore best
    // effort — see lib/http/ratelimit.ts — which is the right trade for
    // analytics: never worth a round trip to enforce precisely.
    const limit = inMemoryLimit(
      `events:${clientKey(request, user?.id)}`,
      LIMITS.eventsPerMinute,
      60_000
    );
    if (!limit.allowed) {
      return tooManyRequests('Slow down.', limit.retryAfterSeconds);
    }

    await recordEvent({
      eventType,
      restaurantId: typeof restaurantId === 'string' ? restaurantId : null,
      dishId: typeof dishId === 'string' ? dishId : null,
      userId: user?.id ?? null,
      anonId: typeof anonId === 'string' ? anonId.slice(0, 64) : null,
      city: typeof city === 'string' ? city : null,
    });

    return ok({ recorded: true });
  } catch (err) {
    return serverError(err, 'API/events');
  }
}
