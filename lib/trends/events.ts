/**
 * Engagement event recording.
 *
 * These are OUR events about OUR app: a user opened a restaurant page, saved
 * it, left feedback. Nothing here observes activity on another platform.
 * They exist because the Trend Score needs a time dimension, which the
 * original schema had no way to express.
 *
 * Save/unsave and submission events are written by database triggers
 * (migration 001) so history cannot be lost by an API caller forgetting. This
 * module handles the view/search events that only the client knows about.
 */

import { supabase } from '@/lib/supabase/client';

export type ClientEventType =
  | 'restaurant_view'
  | 'restaurant_detail_view'
  | 'dish_view'
  | 'search';

const CLIENT_EVENT_TYPES: ClientEventType[] = [
  'restaurant_view',
  'restaurant_detail_view',
  'dish_view',
  'search',
];

export function isClientEventType(value: unknown): value is ClientEventType {
  return (
    typeof value === 'string' &&
    CLIENT_EVENT_TYPES.includes(value as ClientEventType)
  );
}

export interface RecordEventInput {
  eventType: ClientEventType;
  restaurantId?: string | null;
  dishId?: string | null;
  /** Verified user id, or null for anonymous. Never taken from the body. */
  userId?: string | null;
  /**
   * Opaque per-install id for anonymous unique counts. Treated as a pseudonym:
   * we never resolve it to a person, and it is the only identifier stored for
   * signed-out activity.
   */
  anonId?: string | null;
  city?: string | null;
  source?: string;
}

export async function recordEvent(input: RecordEventInput): Promise<void> {
  const { error } = await supabase.from('engagement_events').insert({
    event_type: input.eventType,
    restaurant_id: input.restaurantId ?? null,
    dish_id: input.dishId ?? null,
    user_id: input.userId ?? null,
    anon_id: input.userId ? null : input.anonId ?? null,
    city: input.city ?? null,
    source: input.source ?? 'mobile',
  });

  // Analytics must never break a user-facing request.
  if (error) console.warn('[Events] insert failed:', error.message);
}

export async function recordEvents(inputs: RecordEventInput[]): Promise<void> {
  if (inputs.length === 0) return;

  const rows = inputs.map((input) => ({
    event_type: input.eventType,
    restaurant_id: input.restaurantId ?? null,
    dish_id: input.dishId ?? null,
    user_id: input.userId ?? null,
    anon_id: input.userId ? null : input.anonId ?? null,
    city: input.city ?? null,
    source: input.source ?? 'mobile',
  }));

  const { error } = await supabase.from('engagement_events').insert(rows);
  if (error) console.warn('[Events] batch insert failed:', error.message);
}
