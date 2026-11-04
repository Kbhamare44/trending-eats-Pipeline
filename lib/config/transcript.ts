/**
 * Transcript fetching config.
 *
 * Supadata is a paid API on top of Gemini and Places, so every knob that
 * affects spend is here and env-overridable.
 */

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}

export const TRANSCRIPT_CONFIG = {
  /**
   * Master switch. Off means the pipeline runs on captions exactly as it did
   * before, with no Supadata calls and no spend.
   */
  enabled: bool('TRANSCRIPT_ENABLED', true),

  /**
   * Total time to wait for an async job before giving up, in milliseconds.
   *
   * 30s as specified. This runs in the background worker, not the request
   * path, so it delays when a restaurant appears on the map — not a user
   * staring at a spinner.
   */
  pollBudgetMs: num('TRANSCRIPT_POLL_BUDGET_MS', 30_000),

  /** Supadata's docs suggest polling about once a second. */
  pollIntervalMs: num('TRANSCRIPT_POLL_INTERVAL_MS', 1_000),

  /** Per-HTTP-request timeout. */
  requestTimeoutMs: num('TRANSCRIPT_REQUEST_TIMEOUT_MS', 15_000),

  /**
   * Only fetch a transcript when the caption is thinner than this many
   * characters.
   *
   * 0 means always fetch. Set it above 0 to spend a credit only where the
   * caption is unlikely to name a dish — the cost/benefit depends on
   * measurement we have not been able to do yet (no seeded content), so the
   * default is to always fetch and gather that data.
   */
  captionLengthFloor: num('TRANSCRIPT_CAPTION_FLOOR', 0),
} as const;

/** Mirrors the raw_submissions.transcript_status check constraint. */
export type TranscriptStatus = 'not_attempted' | 'ok' | 'unavailable' | 'failed';
