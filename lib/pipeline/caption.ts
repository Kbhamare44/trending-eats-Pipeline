import { supabase } from '@/lib/supabase/client';

export interface CaptionResult {
  text: string | null;
  source: string | null;
  status: 'not_attempted' | 'pending' | 'ok' | 'unavailable' | 'failed';
}

/** A user-submitted URL only. No media, creator discovery or engagement metrics. */
export async function fetchCaption(submissionId: string, videoId: string, url: string): Promise<CaptionResult> {
  const cached = await supabase.from('raw_submissions')
    .select('caption,caption_source,caption_fetch_status,caption_fetched_at')
    .eq('tiktok_video_id', videoId).not('caption', 'is', null).neq('caption', '')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (cached.error) throw new Error('Could not check the caption cache');
  if (cached.data?.caption?.trim()) {
    const copied = await supabase.from('raw_submissions').update({ caption: cached.data.caption,
      caption_source: cached.data.caption_source ?? 'tiktok-oembed', caption_fetch_status: 'ok',
      caption_fetched_at: cached.data.caption_fetched_at ?? new Date().toISOString(),
    }).eq('id', submissionId);
    if (copied.error) throw new Error('Could not attach the cached caption to this submission');
    return { text: cached.data.caption, source: cached.data.caption_source ?? 'tiktok-oembed', status: 'ok' };
  }

  const attempted = await supabase.from('raw_submissions')
    .select('caption_fetch_status').eq('tiktok_video_id', videoId)
    .not('caption_fetch_status', 'is', null).order('caption_fetched_at', { ascending: false })
    .limit(1).maybeSingle();
  if (attempted.error) throw new Error('Could not check previous caption retrieval');
  if (attempted.data?.caption_fetch_status) return { text: null, source: 'supadata', status: attempted.data.caption_fetch_status };
  // Production default approved by the owner; local/Preview remain opt-in.
  // An explicit false in Vercel disables new paid calls without losing cache reuse.
  const enabled = process.env.CAPTION_METADATA_ENABLED ?? (process.env.VERCEL_ENV === 'production' ? 'true' : 'false');
  if (enabled !== 'true' || !process.env.SUPADATA_API_KEY) {
    return { text: null, source: null, status: 'not_attempted' };
  }

  // Persist before the billed call. If the function dies, retrying the queue
  // reuses this attempt rather than spending another credit. The open-video
  // unique index ensures only one resolved video can be processed at a time.
  const fetchedAt = new Date().toISOString();
  const claimed = await supabase.from('raw_submissions').update({
    caption_source: 'supadata', caption_fetch_status: 'pending', caption_fetched_at: fetchedAt,
  }).eq('id', submissionId);
  if (claimed.error) throw new Error('Could not record the caption retrieval attempt');

  let result: CaptionResult = { text: null, source: 'supadata', status: 'failed' };
  try {
    const endpoint = new URL('https://api.supadata.ai/v1/metadata');
    endpoint.searchParams.set('url', url);
    const response = await fetch(endpoint, {
      headers: { 'x-api-key': process.env.SUPADATA_API_KEY, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json().catch(() => null);
    if (response.ok && body?.platform === 'tiktok' && String(body.id) === videoId) {
      const text = typeof body.description === 'string' ? body.description.trim() : '';
      result = { text: text || null, source: 'supadata', status: text ? 'ok' : 'unavailable' };
    } else if ([403, 404].includes(response.status)) result.status = 'unavailable';
  } catch { /* Continue with speech or ask for clarification; never invent a caption. */ }

  const saved = await supabase.from('raw_submissions').update({
    ...(result.text ? { caption: result.text } : {}),
    caption_source: result.source, caption_fetch_status: result.status, caption_fetched_at: fetchedAt,
  }).eq('id', submissionId);
  if (saved.error) throw new Error('Could not save caption retrieval');
  console.info('[Caption]', { status: result.status, chars: result.text?.length ?? 0 });
  return result;
}
