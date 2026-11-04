/**
 * Trend Score — the "Google Trends for food" number.
 *
 * Design notes, because the shape of this matters more than the arithmetic:
 *
 * 1. It measures MOMENTUM ON TRENDING EATS, from first-party signals only.
 *    Nothing here reads another platform's engagement. That is why the app
 *    labels its rankings "Trending on Trending Eats — <city>" and never claims
 *    to know what is popular on TikTok generally.
 *
 * 2. Growth is smoothed and volume-weighted. Raw percentage growth lets one
 *    save (0 -> 1, "infinite growth") beat forty saves, which would make the
 *    whole ranking worthless at our current data volume.
 *
 * 3. Below `minObservations` we refuse to produce a score. A null score with
 *    an explicit state beats a confident-looking number computed from two
 *    events.
 */

import { TREND_CONFIG, TREND_WEIGHTS, TrendState } from '@/lib/config/trends';

export interface TrendComponent {
  /** Raw measurement in the current window. */
  current: number;
  /** Same measurement in the preceding window. */
  previous: number;
  /** Smoothed growth ratio, current vs previous. */
  growth: number;
  /** 0..1 after normalization and volume weighting. */
  normalized: number;
  /** normalized * weight — what it contributed to the final score. */
  weighted: number;
}

export interface TrendInput {
  /** Unique users who saved in the current / previous window. */
  uniqueSavesCurrent: number;
  uniqueSavesPrevious: number;
  /** Accepted submissions in the current / previous window. */
  submissionsCurrent: number;
  submissionsPrevious: number;
  /** Distinct users with any engagement in the current / previous window. */
  uniqueUsersCurrent: number;
  uniqueUsersPrevious: number;
  /** Hours since the most recent event. null = never any activity. */
  hoursSinceLastActivity: number | null;
  /** Total events in the current window — drives the observations floor. */
  observations: number;
}

export interface TrendResult {
  /** 0..100, or null whenever state !== 'ranked'. */
  score: number | null;
  state: TrendState;
  /** 0..1 — how much data stands behind the score. */
  confidence: number;
  observations: number;
  components: {
    saveGrowth: TrendComponent;
    submissionGrowth: TrendComponent;
    uniqueEngagement: TrendComponent;
    recency: TrendComponent;
  };
  /** Human-readable reason, surfaced in the app for non-ranked entities. */
  explanation: string;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Smoothed growth ratio. k prevents divide-by-zero and stops a 0 -> 1 move
 * from reading as infinite growth: with k=1 it reads as 2x, same as 1 -> 3.
 */
export function smoothedGrowth(
  current: number,
  previous: number,
  k: number = TREND_CONFIG.growthSmoothing
): number {
  return (current + k) / (previous + k);
}

/**
 * Map a growth ratio onto 0..1 logarithmically, so each doubling adds a
 * constant amount rather than the top end dominating. A ratio <= 1 (flat or
 * shrinking) is 0.
 */
export function normalizeGrowth(growth: number): number {
  if (growth <= 1) return 0;
  const ceiling = Math.log2(TREND_CONFIG.maxGrowthRatio);
  if (ceiling <= 0) return 0;
  return clamp01(Math.log2(growth) / ceiling);
}

/**
 * Volume confidence: how much we trust a growth rate given how many events it
 * is based on. sqrt so it rises fast at first then flattens — 1 event out of a
 * target of 10 earns ~32% credit, not 10%.
 */
export function volumeWeight(
  current: number,
  target: number = TREND_CONFIG.volumeTarget
): number {
  if (current <= 0) return 0;
  if (target <= 0) return 1;
  return clamp01(Math.sqrt(current / target));
}

function growthComponent(
  current: number,
  previous: number,
  weight: number
): TrendComponent {
  const growth = smoothedGrowth(current, previous);
  const normalized = clamp01(normalizeGrowth(growth) * volumeWeight(current));
  return { current, previous, growth, normalized, weighted: normalized * weight };
}

/** Exponential decay on time since last activity. */
export function recencyScore(hoursSinceLastActivity: number | null): number {
  if (hoursSinceLastActivity === null) return 0;
  if (hoursSinceLastActivity <= 0) return 1;
  const halfLife = TREND_CONFIG.recencyHalfLifeHours;
  if (halfLife <= 0) return 0;
  return clamp01(Math.pow(0.5, hoursSinceLastActivity / halfLife));
}

export function computeTrendScore(input: TrendInput): TrendResult {
  const saveGrowth = growthComponent(
    input.uniqueSavesCurrent,
    input.uniqueSavesPrevious,
    TREND_WEIGHTS.saveGrowth
  );

  const submissionGrowth = growthComponent(
    input.submissionsCurrent,
    input.submissionsPrevious,
    TREND_WEIGHTS.submissionGrowth
  );

  // Unique engagement is a LEVEL, not a growth rate: the strategy asks for
  // "unique user engagement", so we normalize against a target headcount.
  const engagementNormalized = clamp01(
    input.uniqueUsersCurrent / TREND_CONFIG.uniqueEngagementTarget
  );
  const uniqueEngagement: TrendComponent = {
    current: input.uniqueUsersCurrent,
    previous: input.uniqueUsersPrevious,
    growth: smoothedGrowth(input.uniqueUsersCurrent, input.uniqueUsersPrevious),
    normalized: engagementNormalized,
    weighted: engagementNormalized * TREND_WEIGHTS.uniqueEngagement,
  };

  const recencyNormalized = recencyScore(input.hoursSinceLastActivity);
  const recency: TrendComponent = {
    current: input.hoursSinceLastActivity ?? -1,
    previous: 0,
    growth: 1,
    normalized: recencyNormalized,
    weighted: recencyNormalized * TREND_WEIGHTS.recency,
  };

  const components = { saveGrowth, submissionGrowth, uniqueEngagement, recency };

  const rawScore =
    saveGrowth.weighted +
    submissionGrowth.weighted +
    uniqueEngagement.weighted +
    recency.weighted;

  const score = Math.round(clamp01(rawScore) * 1000) / 10; // 0..100, 1 decimal
  const confidence = clamp01(input.observations / TREND_CONFIG.minObservations);

  // ── The observations floor ────────────────────────────────────────────────
  if (input.observations < TREND_CONFIG.warmingUpObservations) {
    return {
      score: null,
      state: 'insufficient_data',
      confidence,
      observations: input.observations,
      components,
      explanation:
        'Not enough activity yet to measure a trend. Save it or add a video to help.',
    };
  }

  if (input.observations < TREND_CONFIG.minObservations) {
    return {
      score: null,
      state: 'warming_up',
      confidence,
      observations: input.observations,
      components,
      explanation: `Gaining attention — ${input.observations} recent signals, ${TREND_CONFIG.minObservations} needed to rank.`,
    };
  }

  return {
    score,
    state: 'ranked',
    confidence,
    observations: input.observations,
    components,
    explanation: buildExplanation(components),
  };
}

/** Names the single biggest driver, so the app can say WHY something trends. */
function buildExplanation(components: TrendResult['components']): string {
  const ranked = [
    { label: 'a jump in saves', value: components.saveGrowth.weighted },
    { label: 'new videos being added', value: components.submissionGrowth.weighted },
    { label: 'broad interest from users', value: components.uniqueEngagement.weighted },
    { label: 'very recent activity', value: components.recency.weighted },
  ].sort((a, b) => b.value - a.value);

  const top = ranked[0];
  if (!top || top.value <= 0) return 'Trending on recent activity.';
  return `Trending mostly on ${top.label}.`;
}

/**
 * Hype Score — the popularity side of Hype vs Reality.
 *
 * Deliberately NOT the trend score: trend is momentum (change), hype is
 * accumulated attention (level). A restaurant can be high-hype and flat, or
 * low-hype and sharply trending.
 */
export function computeHypeScore(input: {
  reviewCount: number;
  savesCount: number;
  uniqueUsers: number;
}): number {
  const reviews = clamp01(input.reviewCount / 10);
  const saves = clamp01(input.savesCount / 50);
  const reach = clamp01(input.uniqueUsers / 50);
  const raw = reviews * 0.45 + saves * 0.35 + reach * 0.2;
  return Math.round(clamp01(raw) * 1000) / 10;
}
