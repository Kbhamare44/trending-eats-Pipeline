/**
 * GET /api/restaurants/:id
 *
 * The restaurant detail page: AI summary, the TikTok sources behind it, the
 * dishes people mention, and the Hype vs Reality block.
 *
 * Source videos are returned as oEmbed HTML and a link. We never serve video
 * files, and the embed is rendered in a WebView so playback and attribution
 * stay with TikTok.
 */

import type { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase/client';
import {
  presentRestaurant,
  RESTAURANT_COLUMNS,
} from '@/lib/presenters/restaurant';
import { ok, notFound, serverError } from '@/lib/http/respond';
import { getAuthedUser } from '@/lib/auth/verify';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const { data: row, error } = await supabase
      .from('restaurants')
      .select(
        `${RESTAURANT_COLUMNS},
         restaurant_dishes ( mention_count, review_count, avg_sentiment,
                             dishes ( id, slug, name, family, category,
                                      trend_state, trend_score ) )`
      )
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    if (!row) return notFound('Restaurant not found');

    const { data: reviews, error: reviewError } = await supabase
      .from('reviews')
      .select(
        `id, tiktok_url, embed_html, thumbnail_url, creator_username,
         sentiment, sentiment_score, dishes_mentioned, reviewer_summary,
         pros, cons, atmosphere, price_range, good_for,
         is_sponsored, sponsorship_confidence, created_at`
      )
      .eq('restaurant_id', id)
      .order('created_at', { ascending: false });

    if (reviewError) throw reviewError;

    const { data: feedback, error: feedbackError } = await supabase
      .from('restaurant_feedback')
      .select('rating, would_return, dish, comment, created_at')
      .eq('restaurant_id', id)
      .order('created_at', { ascending: false })
      .limit(20);

    if (feedbackError) throw feedbackError;

    // Is the signed-in caller's own save/feedback already in place? Lets the
    // app render the correct button state on first paint.
    const user = await getAuthedUser(request);
    let viewer = { saved: false, hasFeedback: false, myRating: null as number | null };

    if (user) {
      const [{ data: save }, { data: mine }] = await Promise.all([
        supabase
          .from('restaurant_saves')
          .select('id')
          .eq('restaurant_id', id)
          .eq('user_id', user.id)
          .maybeSingle(),
        supabase
          .from('restaurant_feedback')
          .select('rating')
          .eq('restaurant_id', id)
          .eq('user_id', user.id)
          .maybeSingle(),
      ]);

      viewer = {
        saved: Boolean(save),
        hasFeedback: Boolean(mine),
        myRating: mine?.rating ?? null,
      };
    }

    return ok({
      restaurant: presentRestaurant(row),
      sources: (reviews ?? []).map((r) => ({
        id: r.id,
        tiktokUrl: r.tiktok_url,
        embedHtml: r.embed_html,
        thumbnailUrl: r.thumbnail_url,
        creatorUsername: r.creator_username,
        summary: r.reviewer_summary,
        sentiment: r.sentiment,
        sentimentScore: r.sentiment_score,
        dishesMentioned: r.dishes_mentioned ?? [],
        pros: r.pros ?? [],
        cons: r.cons ?? [],
        atmosphere: r.atmosphere,
        priceRange: r.price_range,
        goodFor: r.good_for ?? [],
        isSponsored: r.is_sponsored,
        sponsorshipConfidence: r.sponsorship_confidence,
        createdAt: r.created_at,
      })),
      feedback: (feedback ?? []).map((f) => ({
        rating: f.rating,
        wouldReturn: f.would_return,
        dish: f.dish,
        comment: f.comment,
        createdAt: f.created_at,
      })),
      viewer,
      meta: {
        sourceCount: reviews?.length ?? 0,
        feedbackCount: feedback?.length ?? 0,
        /** Shown next to any embedded video. */
        sourceNote:
          'Videos are embedded from TikTok and remain the property of their creators.',
      },
    });
  } catch (err) {
    return serverError(err, 'API/restaurants/[id]');
  }
}
