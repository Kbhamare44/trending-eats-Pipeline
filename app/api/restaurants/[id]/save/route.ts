/**
 * POST   /api/restaurants/:id/save   — save
 * DELETE /api/restaurants/:id/save   — unsave
 *
 * Saves are the heaviest single input to the Trend Score (40%), so they must
 * be attributable to a verified user. The user id comes from the bearer token,
 * never from the request body — otherwise one script could manufacture a
 * trend by saving as thousands of invented users.
 *
 * Database triggers keep restaurants.saves_count in step and append the
 * history row to engagement_events.
 */

import type { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase/client';
import { getAuthedUser } from '@/lib/auth/verify';
import {
  ok,
  created,
  unauthorized,
  notFound,
  serverError,
} from '@/lib/http/respond';

async function restaurantExists(id: string): Promise<boolean> {
  const { data } = await supabase
    .from('restaurants')
    .select('id')
    .eq('id', id)
    .maybeSingle();
  return Boolean(data);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await getAuthedUser(request);
    if (!user) return unauthorized('Sign in to save a restaurant');

    if (!(await restaurantExists(id))) return notFound('Restaurant not found');

    const { error } = await supabase
      .from('restaurant_saves')
      .insert({ restaurant_id: id, user_id: user.id });

    if (error) {
      // 23505 = unique violation: already saved. Idempotent success.
      if (error.code === '23505') {
        return ok({ saved: true, alreadySaved: true });
      }
      throw error;
    }

    return created({ saved: true, alreadySaved: false });
  } catch (err) {
    return serverError(err, 'API/restaurants/[id]/save POST');
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await getAuthedUser(request);
    if (!user) return unauthorized('Sign in to manage your saves');

    const { error } = await supabase
      .from('restaurant_saves')
      .delete()
      .eq('restaurant_id', id)
      .eq('user_id', user.id);

    if (error) throw error;

    return ok({ saved: false });
  } catch (err) {
    return serverError(err, 'API/restaurants/[id]/save DELETE');
  }
}

/** GET returns whether the caller has saved it. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await getAuthedUser(request);
    if (!user) return ok({ saved: false, authenticated: false });

    const { data } = await supabase
      .from('restaurant_saves')
      .select('id')
      .eq('restaurant_id', id)
      .eq('user_id', user.id)
      .maybeSingle();

    return ok({ saved: Boolean(data), authenticated: true });
  } catch (err) {
    return serverError(err, 'API/restaurants/[id]/save GET');
  }
}
