/**
 * Submission queue tuning.
 *
 * Every value is env-overridable so the queue can be retuned on a deployed
 * instance without a code change, the same convention as lib/config/trends.ts.
 */

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const QUEUE_CONFIG = {
  /**
   * How many submissions one cron invocation drains. Each costs an oEmbed
   * call, two Gemini calls and up to two Places calls, so this is really a
   * bound on wall-clock time per invocation, not a throughput target.
   */
  batchSize: num('QUEUE_BATCH_SIZE', 5),

  /**
   * A row still in `processing` after this long is assumed abandoned — the
   * function that claimed it hit the platform timeout, or the deployment was
   * replaced mid-flight. Without this, such a row is stuck forever: it is not
   * `pending`, so nothing ever picks it up again.
   */
  stuckAfterMinutes: num('QUEUE_STUCK_AFTER_MINUTES', 10),

  /**
   * Total claim attempts before a submission is marked `failed`. Three covers
   * transient failures (a Gemini 503, a Places rate limit) without letting a
   * permanently broken URL consume quota on every single cron run.
   */
  maxAttempts: num('QUEUE_MAX_ATTEMPTS', 3),

  /**
   * Concurrent background drains allowed per process.
   *
   * 2, not 5. Each drain makes one Supadata call, two Gemini calls and up to
   * two Places calls, and the free/low tiers of those providers are the
   * binding constraint — not our CPU. Submissions beyond the gate stay
   * `pending` and the cron drains them serially, so a burst is flattened
   * rather than dropped.
   */
  maxConcurrentDrains: num('QUEUE_MAX_CONCURRENT_DRAINS', 2),
} as const;

if (QUEUE_CONFIG.maxAttempts < 1) {
  throw new Error('QUEUE_MAX_ATTEMPTS must be at least 1');
}

/**
 * A status that will never change again without manual intervention.
 *
 * Lives here rather than in lib/supabase/queries.ts so it can be imported
 * without pulling in the Supabase client, which throws at module load when
 * credentials are absent. The offline check scripts need exactly that.
 */
export function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'rejected' || status === 'failed';
}
