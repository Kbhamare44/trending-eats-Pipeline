/**
 * POST /api/restaurants/:id/feedback   — leave or update your own report
 * GET  /api/restaurants/:id/feedback   — read reports for a restaurant
 *
 * This is the first-party half of Hype vs Reality: our own users telling us
 * what the visit was actually like. It is weighted highest in the experience
 * signal because it is ours, tied to a confirmed account, and not subject to
 * another platform's terms.
 *
 * One row per user per restaurant, editable — so a user cannot stack ratings
 * to move a real business's score.
 */

import type { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase/client';
import { getAuthedUser } from '@/lib/auth/verify';
import { recomputeExperienceSignals } from '@/lib/trends/recompute';
import { feedbackAuthorRef, isObjectionableText } from '@/lib/moderation';
import {
  ok,
  created,
  badRequest,
  unauthorized,
  notFound,
  serverError,
} from '@/lib/http/respond';

export const maxDuration = 30;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const { data, error } = await supabase
      .from('restaurant_feedback')
      .select('id, user_id, rating, would_return, visited, dish, comment, created_at')
      .eq('restaurant_id', id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    const ratings = (data ?? []).map((f) => f.rating);
    const average =
      ratings.length > 0
        ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100
        : null;

    return ok({
      feedback: (data ?? []).map((f) => ({
        id: f.id,
        authorRef: feedbackAuthorRef(f.user_id),
        rating: f.rating,
        wouldReturn: f.would_return,
        visited: f.visited,
        dish: isObjectionableText(f.dish) ? null : f.dish,
        comment: isObjectionableText(f.comment) ? null : f.comment,
        createdAt: f.created_at,
      })),
      summary: {
        count: ratings.length,
        average,
        // Deliberately no verdict here — a verdict needs the full experience
        // signal, which weighs this against other sources and enforces the
        // minimum-evidence rules.
      },
    });
  } catch (err) {
    return serverError(err, 'API/restaurants/[id]/feedback GET');
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await getAuthedUser(request);
    if (!user) return unauthorized('Sign in to leave feedback');

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return badRequest('A JSON body is required');
    }

    const { rating, wouldReturn, visited, dish, comment } = body as Record<
      string,
      unknown
    >;

    const parsedRating = Number(rating);
    if (
      !Number.isInteger(parsedRating) ||
      parsedRating < 1 ||
      parsedRating > 5
    ) {
      return badRequest('rating must be a whole number from 1 to 5');
    }

    const { data: restaurant } = await supabase
      .from('restaurants')
      .select('id')
      .eq('id', id)
      .maybeSingle();

    if (!restaurant) return notFound('Restaurant not found');

    const trimmedComment =
      typeof comment === 'string' ? comment.trim().slice(0, 1000) : null;
    const trimmedDish =
      typeof dish === 'string' ? dish.trim().slice(0, 120) : null;
    if (isObjectionableText(trimmedComment) || isObjectionableText(trimmedDish)) {
      return badRequest('Please remove abusive, explicit or threatening language and links. Honest negative food reviews are welcome.');
    }

    const { data: existing } = await supabase
      .from('restaurant_feedback')
      .select('id')
      .eq('restaurant_id', id)
      .eq('user_id', user.id)
      .maybeSingle();

    const { error } = await supabase.from('restaurant_feedback').upsert(
      {
        restaurant_id: id,
        user_id: user.id,
        rating: parsedRating,
        would_return: typeof wouldReturn === 'boolean' ? wouldReturn : null,
        visited: typeof visited === 'boolean' ? visited : true,
        dish: trimmedDish,
        comment: trimmedComment || null,
      },
      { onConflict: 'restaurant_id,user_id' }
    );

    if (error) throw error;

    // Recompute immediately so the user sees their own report reflected.
    // Cheap at current scale; if this gets slow, drop it and rely on the cron.
    try {
      await recomputeExperienceSignals();
    } catch (recomputeError: any) {
      console.warn(
        '[Feedback] experience recompute failed:',
        recomputeError.message
      );
    }

    const { data: refreshed } = await supabase
      .from('restaurants')
      .select(
        'experience_score, experience_state, experience_observations, hype_vs_reality, first_party_rating, first_party_rating_count'
      )
      .eq('id', id)
      .maybeSingle();

    const payload = {
      saved: true,
      updated: Boolean(existing),
      experience: refreshed ?? null,
    };

    return existing ? ok(payload) : created(payload);
  } catch (err) {
    return serverError(err, 'API/restaurants/[id]/feedback POST');
  }
}

/** Lets a user withdraw their own report. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await getAuthedUser(request);
    if (!user) return unauthorized('Sign in to manage your feedback');

    const { error } = await supabase
      .from('restaurant_feedback')
      .delete()
      .eq('restaurant_id', id)
      .eq('user_id', user.id);

    if (error) throw error;

    try {
      await recomputeExperienceSignals();
    } catch {
      /* cron will catch up */
    }

    return ok({ deleted: true });
  } catch (err) {
    return serverError(err, 'API/restaurants/[id]/feedback DELETE');
  }
}
