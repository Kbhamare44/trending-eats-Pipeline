/**
 * Transcripts for user-submitted TikTok URLs, via Supadata.
 *
 * WHY: Gemini currently sees only the caption, which is often a few words and
 * some hashtags. The creator describing the food out loud is far richer for
 * extracting dish names.
 *
 * ── COMPLIANCE BOUNDARY, since this is the part most easily mistaken for
 * something it is not ──
 *
 * This calls Supadata's transcript endpoint with a URL A USER PASTED IN. It
 * does not download, store or serve any video or audio file. It does not
 * enumerate creators, search TikTok, or fetch anything the user did not hand
 * us. Nothing here discovers content on its own.
 *
 * If a future change makes this module fetch media, or fetch a URL that no
 * user submitted, it has left the scope described in COMPLIANCE.md and in the
 * App Store review notes, both of which state this boundary explicitly.
 *
 * ── FAILURE POSTURE ──
 *
 * A transcript is an enhancement, never a requirement. Every path here
 * resolves to a status rather than throwing, and the caller carries on with
 * the caption. A submission must never fail because a transcript did not
 * arrive.
 */

import { supabase } from '@/lib/supabase/client';
import {
  TRANSCRIPT_CONFIG,
  type TranscriptStatus,
} from '@/lib/config/transcript';

const API_BASE = 'https://api.supadata.ai/v1';

export interface TranscriptResult {
  status: TranscriptStatus;
  /** Plain text, or null unless status is 'ok'. */
  text: string | null;
  /** Where it came from: 'supadata', 'supadata-cache', or null. */
  source: string | null;
  lang: string | null;
  /** Why it is not 'ok', for logs and for the submission row. */
  detail?: string;
}

const NOT_ATTEMPTED: TranscriptResult = {
  status: 'not_attempted',
  text: null,
  source: null,
  lang: null,
};

export function isTranscriptConfigured(): boolean {
  return TRANSCRIPT_CONFIG.enabled && Boolean(process.env.SUPADATA_API_KEY);
}

/**
 * Pull `content` out of a Supadata payload.
 *
 * The API returns a string when `text=true` and an array of timed cues
 * otherwise. We always ask for text, but handle the array shape too so a
 * default change on their side degrades to "joined cues" rather than to
 * "transcript silently empty".
 */
function readContent(payload: any): string {
  const content = payload?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((cue: any) => (typeof cue?.text === 'string' ? cue.text : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return '';
}

async function call(path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'GET',
    headers: {
      'x-api-key': process.env.SUPADATA_API_KEY as string,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(TRANSCRIPT_CONFIG.requestTimeoutMs),
  });

  const text = await response.text().catch(() => '');
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: response.status, body };
}

/**
 * Poll an async job until it finishes or the budget runs out.
 *
 * The budget is wall-clock from the first poll. A job still running when it
 * expires is reported 'failed', not 'unavailable': the distinction matters
 * because 'unavailable' means Supadata told us there is no transcript, while
 * 'failed' means we stopped waiting and a retry might succeed.
 */
async function pollJob(jobId: string): Promise<TranscriptResult> {
  const deadline = Date.now() + TRANSCRIPT_CONFIG.pollBudgetMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, TRANSCRIPT_CONFIG.pollIntervalMs));

    const { status, body } = await call(`/transcript/${encodeURIComponent(jobId)}`);

    // Results expire an hour after completion; a 404 here means the job id is
    // gone, which we cannot recover from.
    if (status === 404) {
      return {
        status: 'failed',
        text: null,
        source: null,
        lang: null,
        detail: 'job id expired or unknown',
      };
    }

    if (status >= 400) {
      return {
        status: 'failed',
        text: null,
        source: null,
        lang: null,
        detail: `poll returned ${status}`,
      };
    }

    const jobStatus = body?.status;

    if (jobStatus === 'completed') {
      const text = readContent(body);
      if (!text) {
        // Supadata documents an empty result as "transcription succeeded but
        // no speech detected" — a silent video. That is a real answer, so it
        // is 'unavailable' rather than 'failed', and retrying would just
        // spend another credit on the same silence.
        return {
          status: 'unavailable',
          text: null,
          source: 'supadata',
          lang: body?.lang ?? null,
          detail: 'no speech detected',
        };
      }
      return {
        status: 'ok',
        text,
        source: 'supadata',
        lang: body?.lang ?? null,
      };
    }

    if (jobStatus === 'failed') {
      return {
        status: 'failed',
        text: null,
        source: null,
        lang: null,
        detail: String(body?.error ?? 'job failed').slice(0, 200),
      };
    }

    // 'queued' or 'active' — keep waiting.
  }

  return {
    status: 'failed',
    text: null,
    source: null,
    lang: null,
    detail: `gave up after ${TRANSCRIPT_CONFIG.pollBudgetMs}ms`,
  };
}

/**
 * A transcript we already paid for.
 *
 * The same TikTok gets submitted more than once — that is the whole point of
 * the submission-growth trend component — and each one would otherwise cost
 * another credit for text we already hold. Keyed on tiktok_video_id, so it
 * only matches when we are certain it is the same video.
 */
async function findCachedTranscript(
  videoId: string | null
): Promise<TranscriptResult | null> {
  if (!videoId) return null;

  const { data, error } = await supabase
    .from('raw_submissions')
    .select('transcript, transcript_source, transcript_status')
    .eq('tiktok_video_id', videoId)
    .eq('transcript_status', 'ok')
    .not('transcript', 'is', null)
    .limit(1)
    .maybeSingle();

  if (error || !data?.transcript) return null;

  return {
    status: 'ok',
    text: data.transcript as string,
    source: 'supadata-cache',
    lang: null,
  };
}

/**
 * Fetch the transcript for a submitted TikTok URL.
 *
 * Never throws. Returns 'not_attempted' when transcripts are switched off or
 * unconfigured, so a caller can tell "we chose not to" from "we tried and
 * could not".
 */
export async function fetchTranscript(
  tiktokUrl: string,
  options: { videoId?: string | null; captionLength?: number } = {}
): Promise<TranscriptResult> {
  if (!isTranscriptConfigured()) return NOT_ATTEMPTED;

  // Optional thrift: skip the credit when the caption is already substantial.
  const floor = TRANSCRIPT_CONFIG.captionLengthFloor;
  if (floor > 0 && (options.captionLength ?? 0) >= floor) {
    return { ...NOT_ATTEMPTED, detail: 'caption long enough' };
  }

  const cached = await findCachedTranscript(options.videoId ?? null);
  if (cached) return cached;

  try {
    const params = new URLSearchParams({
      url: tiktokUrl,
      text: 'true',
      mode: 'auto',
    });
    const { status, body } = await call(`/transcript?${params.toString()}`);

    // 202 means the work was queued; the id is in `jobId`.
    if (status === 202) {
      const jobId = body?.jobId;
      if (typeof jobId !== 'string' || !jobId) {
        return {
          status: 'failed',
          text: null,
          source: null,
          lang: null,
          detail: '202 without a jobId',
        };
      }
      return await pollJob(jobId);
    }

    // 206 is documented as "transcript unavailable" and is still billed a
    // credit. Recording it as 'unavailable' is what stops us paying that
    // credit again for the same video on the next submission.
    if (status === 206) {
      return {
        status: 'unavailable',
        text: null,
        source: 'supadata',
        lang: null,
        detail: 'supadata reported no transcript available',
      };
    }

    // The video is private, restricted or gone. Not our failure, and
    // retrying will not change it.
    if (status === 403 || status === 404) {
      return {
        status: 'unavailable',
        text: null,
        source: 'supadata',
        lang: null,
        detail: status === 403 ? 'video restricted' : 'video not found',
      };
    }

    if (status === 200) {
      const text = readContent(body);
      if (!text) {
        return {
          status: 'unavailable',
          text: null,
          source: 'supadata',
          lang: body?.lang ?? null,
          detail: 'no speech detected',
        };
      }
      return { status: 'ok', text, source: 'supadata', lang: body?.lang ?? null };
    }

    return {
      status: 'failed',
      text: null,
      source: null,
      lang: null,
      detail: `unexpected status ${status}`,
    };
  } catch (err: any) {
    return {
      status: 'failed',
      text: null,
      source: null,
      lang: null,
      detail: (err?.message ?? String(err)).slice(0, 200),
    };
  }
}

/** Persist whatever we got onto the submission row. Never throws. */
export async function saveTranscript(
  submissionId: string,
  result: TranscriptResult
): Promise<void> {
  if (result.status === 'not_attempted') return;

  const { error } = await supabase
    .from('raw_submissions')
    .update({
      transcript: result.text,
      transcript_source: result.source,
      transcript_status: result.status,
      transcript_fetched_at: new Date().toISOString(),
    })
    .eq('id', submissionId);

  if (error) {
    console.warn(
      `[Transcript] could not save for ${submissionId}: ${error.message}`
    );
  }
}
