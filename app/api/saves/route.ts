/**
 * GET /api/saves — the signed-in user's saved restaurants.
 *
 * Scoped to the bearer token's user. There is deliberately no way to ask for
 * somebody else's saves: they are private, and the RLS policy in migration
 * 004 enforces the same thing for any client reaching Supabase directly.
 */

import type { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase/client';
import { getAuthedUser } from '@/lib/auth/verify';
import {
  presentRestaurant,
  RESTAURANT_COLUMNS,
} from '@/lib/presenters/restaurant';
import { ok, unauthorized, serverError } from '@/lib/http/respond';

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthedUser(request);
    if (!user) return unauthorized('Sign in to see your saves');

    const { data: saves, error: saveError } = await supabase
      .from('restaurant_saves')
      .select('restaurant_id, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (saveError) throw saveError;

    const ids = (saves ?? []).map((s) => s.restaurant_id);
    if (ids.length === 0) {
      return ok({ restaurants: [], meta: { count: 0 } });
    }

    const { data, error } = await supabase
      .from('restaurants')
      .select(RESTAURANT_COLUMNS)
      .in('id', ids);

    if (error) throw error;

    const savedAt = new Map(
      (saves ?? []).map((s) => [s.restaurant_id, s.created_at])
    );

    // Preserve save order (most recently saved first) rather than table order.
    const restaurants = (data ?? [])
      .map((row) => ({
        ...presentRestaurant(row),
        savedAt: savedAt.get(row.id) ?? null,
      }))
      .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));

    return ok({ restaurants, meta: { count: restaurants.length } });
  } catch (err) {
    return serverError(err, 'API/saves');
  }
}
