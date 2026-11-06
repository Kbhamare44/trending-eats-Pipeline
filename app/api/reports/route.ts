import type { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase/client';
import { getAuthedUser } from '@/lib/auth/verify';
import { badRequest, created, notFound, serverError } from '@/lib/http/respond';
import { clientKey, inMemoryLimit, tooManyRequests } from '@/lib/http/ratelimit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = new Set(['abuse', 'spam', 'rights', 'other']);

/** Anonymous reporting remains available; the moderation queue is service-only. */
export async function POST(request: NextRequest) {
  try {
    const user = await getAuthedUser(request);
    const limit = inMemoryLimit(`content-reports:${clientKey(request, user?.id)}`, 5, 60_000);
    if (!limit.allowed) return tooManyRequests('Too many reports. Please try again shortly.', limit.retryAfterSeconds);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return badRequest('A JSON body is required');
    const { restaurantId, contentType, contentId, reason } = body as Record<string, unknown>;
    if (typeof restaurantId !== 'string' || !UUID.test(restaurantId) || typeof contentId !== 'string' || !UUID.test(contentId)) return badRequest('A valid restaurant and content ID are required');
    if (contentType !== 'review' && contentType !== 'feedback') return badRequest('Choose a video or user report to report');
    if (typeof reason !== 'string' || !REASONS.has(reason)) return badRequest('Choose a report reason');

    const { data: target, error: targetError } = await supabase
      .from(contentType === 'review' ? 'reviews' : 'restaurant_feedback')
      .select('id').eq('id', contentId).eq('restaurant_id', restaurantId).maybeSingle();
    if (targetError) throw new Error('Could not verify the reported content');
    if (!target) return notFound('This content is no longer available');

    const { error } = await supabase.from('content_reports').insert({
      restaurant_id: restaurantId, content_type: contentType, content_id: contentId,
      reason, reported_by: user?.id ?? null,
    });
    if (error) throw new Error('Could not save the content report');
    return created({ reported: true });
  } catch (error) {
    return serverError(error, 'API/reports');
  }
}
