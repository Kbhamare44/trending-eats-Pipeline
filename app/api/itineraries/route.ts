/**
 * Saved outings.
 *
 *   GET    /api/itineraries   the signed-in user's saved pairings
 *   POST   /api/itineraries   save one
 *   DELETE /api/itineraries?id=...
 *
 * WHY SAVING EXISTS IN THE SMALLEST VERSION: the point of shipping a pairing
 * rather than an optimizer is to find out whether anyone wants it. "Wants it"
 * is not measurable from suggestions being generated — the app generates
 * those by itself. A save is a person choosing one, which is the only signal
 * that distinguishes interest from traffic.
 *
 * Authenticated throughout: an itinerary belongs to a person, and
 * `itineraries.user_id` cascades from auth.users.
 */

import type { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase/client';
import { getAuthedUser } from '@/lib/auth/verify';
import {
  ok,
  created,
  badRequest,
  unauthorized,
  notFound,
  serverError,
} from '@/lib/http/respond';

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthedUser(request);
    if (!user) return unauthorized('Sign in to see your saved outings');

    const { data, error } = await supabase
      .from('itineraries')
      .select(
        `id, title, city, planned_for, created_at,
         itinerary_stops (
           id, position, arrive_at, travel_minutes,
           restaurants ( id, name, city, cuisine_type, price_level ),
           activities ( id, name, category, address, google_rating )
         )`
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);

    const itineraries = (data ?? []).map((row: any) => ({
      id: row.id,
      title: row.title,
      city: row.city,
      plannedFor: row.planned_for,
      createdAt: row.created_at,
      stops: (row.itinerary_stops ?? [])
        .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0))
        .map((stop: any) => ({
          id: stop.id,
          position: stop.position,
          travelMinutes: stop.travel_minutes,
          restaurant: stop.restaurants ?? null,
          activity: stop.activities ?? null,
        })),
    }));

    return ok({ itineraries, meta: { count: itineraries.length } });
  } catch (err) {
    return serverError(err, 'API/itineraries GET');
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthedUser(request);
    if (!user) return unauthorized('Sign in to save an outing');

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return badRequest('A JSON body is required');
    }

    const { restaurantId, activityId, walkMinutes, city, title, plannedFor } =
      body as Record<string, unknown>;

    if (typeof restaurantId !== 'string' || !restaurantId) {
      return badRequest('restaurantId is required');
    }
    // activityId may be absent: an activity is only cached when the Places
    // upsert succeeded, and a pairing is still worth saving without it.
    const activity = typeof activityId === 'string' && activityId ? activityId : null;

    const { data: itinerary, error: itineraryError } = await supabase
      .from('itineraries')
      .insert({
        user_id: user.id,
        title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : null,
        city: typeof city === 'string' && city.trim() ? city.trim().slice(0, 120) : null,
        planned_for: typeof plannedFor === 'string' ? plannedFor : null,
      })
      .select('id')
      .single();

    if (itineraryError) throw new Error(itineraryError.message);

    const stops: Array<Record<string, unknown>> = [
      { itinerary_id: itinerary.id, position: 1, restaurant_id: restaurantId },
    ];
    if (activity) {
      stops.push({
        itinerary_id: itinerary.id,
        position: 2,
        activity_id: activity,
        travel_minutes:
          typeof walkMinutes === 'number' && Number.isFinite(walkMinutes)
            ? Math.round(walkMinutes)
            : null,
      });
    }

    const { error: stopsError } = await supabase.from('itinerary_stops').insert(stops);

    if (stopsError) {
      // Leave no half-saved outing behind. The header row cascades its stops,
      // so deleting it is enough.
      await supabase.from('itineraries').delete().eq('id', itinerary.id);
      throw new Error(`Could not save the stops: ${stopsError.message}`);
    }

    return created({ id: itinerary.id, stops: stops.length });
  } catch (err) {
    return serverError(err, 'API/itineraries POST');
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await getAuthedUser(request);
    if (!user) return unauthorized('Sign in to delete an outing');

    const id = request.nextUrl.searchParams.get('id');
    if (!id) return badRequest('id is required');

    // Scoped by user_id as well as id: without it, knowing an id would be
    // enough to delete somebody else's outing.
    const { data, error } = await supabase
      .from('itineraries')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id)
      .select('id');

    if (error) throw new Error(error.message);
    if (!data?.length) return notFound('No such outing');

    return ok({ ok: true });
  } catch (err) {
    return serverError(err, 'API/itineraries DELETE');
  }
}
