/**
 * Trend scoring configuration.
 *
 * Every number here is an INITIAL EXPERIMENTAL WEIGHT, as the v2 strategy
 * says. They are collected in one file precisely so they can be re-tuned
 * against `trend_snapshots` history rather than hunted through the codebase.
 *
 * Override any of them with an env var of the same name if you want to
 * experiment in production without a deploy.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Component weights. Must sum to 1. Asserted at module load. */
export const TREND_WEIGHTS = {
  /** Growth in unique users who saved this restaurant. */
  saveGrowth: num('TREND_W_SAVE_GROWTH', 0.40),
  /** Growth in accepted submissions (new TikTok sources) for it. */
  submissionGrowth: num('TREND_W_SUBMISSION_GROWTH', 0.25),
  /** Distinct users who engaged with it at all in the window. */
  uniqueEngagement: num('TREND_W_UNIQUE_ENGAGEMENT', 0.20),
  /** How recently anything happened. */
  recency: num('TREND_W_RECENCY', 0.15),
} as const;

const weightSum = Object.values(TREND_WEIGHTS).reduce((a, b) => a + b, 0);
if (Math.abs(weightSum - 1) > 1e-6) {
  throw new Error(
    `Trend weights must sum to 1, got ${weightSum}. Check TREND_W_* env vars.`
  );
}

export const TREND_CONFIG = {
  /** Comparison window, in days. Current window vs the one before it. */
  windowDays: num('TREND_WINDOW_DAYS', 7),

  /**
   * MINIMUM OBSERVATIONS FLOOR.
   *
   * This is the guard against the problem we actually have today: with four
   * restaurants and no users, a trend ranking is noise dressed up as insight.
   * Below this many observations in the current window, we publish
   * `state: 'insufficient_data'` and a NULL score — we do not publish a rank.
   *
   * Raise this as real traffic arrives.
   */
  minObservations: num('TREND_MIN_OBSERVATIONS', 5),

  /**
   * Between `warmingUpObservations` and `minObservations` we report
   * `state: 'warming_up'`: there is some activity, but not enough to rank.
   * The app shows these as "gaining attention" without a number.
   */
  warmingUpObservations: num('TREND_WARMING_UP_OBSERVATIONS', 2),

  /**
   * Growth is computed with additive smoothing so a 0 -> 1 jump is not an
   * infinite multiplier. growth = (current + k) / (previous + k).
   */
  growthSmoothing: num('TREND_GROWTH_SMOOTHING', 1),

  /**
   * Growth ratio that maps to a normalized 1.0. 8x = three doublings.
   * Anything above this is clamped.
   */
  maxGrowthRatio: num('TREND_MAX_GROWTH_RATIO', 8),

  /**
   * Volume target for confidence. A restaurant with this many events in the
   * window gets full credit for its growth rate; fewer events scales the
   * component down, so 1 save cannot out-rank 40 saves on percentage growth
   * alone.
   */
  volumeTarget: num('TREND_VOLUME_TARGET', 10),

  /** Recency half-life in hours. 72h = activity 3 days old is worth half. */
  recencyHalfLifeHours: num('TREND_RECENCY_HALF_LIFE_HOURS', 72),

  /** Unique-engagement normalization target. */
  uniqueEngagementTarget: num('TREND_UNIQUE_ENGAGEMENT_TARGET', 15),

  /** Dishes need to appear at this many distinct restaurants to be ranked. */
  dishMinRestaurants: num('TREND_DISH_MIN_RESTAURANTS', 2),

  /** Dishes need this many total mentions to be ranked. */
  dishMinMentions: num('TREND_DISH_MIN_MENTIONS', 3),
} as const;

export const EXPERIENCE_CONFIG = {
  /**
   * Evidence CREDIT required before we publish an experience score at all.
   * Below this: `insufficient_data`, score null.
   *
   * Credit, not a raw count. Sources are not interchangeable: a 5.0 from three
   * Google raters is not the same evidence as three people telling us directly
   * that they went. Gating on a raw count let three Google raters clear the
   * floor and present as "measured", which is exactly the kind of false
   * confidence this file exists to prevent. See *Credit constants below.
   */
  minObservations: num('EXPERIENCE_MIN_OBSERVATIONS', 3),

  /**
   * A NEGATIVE classification ("below_expectations") needs more evidence than
   * a positive one. The strategy is explicit: "Require sufficient evidence for
   * negative restaurant classifications" and "Avoid unsupported negative
   * claims." These are real businesses.
   */
  minObservationsForNegative: num('EXPERIENCE_MIN_OBSERVATIONS_NEGATIVE', 5),

  /**
   * How much each input source counts toward confidence. First-party feedback
   * is weighted highest: it is ours, it is tied to a verified account, and it
   * is not subject to another platform's terms.
   */
  weights: {
    firstParty: num('EXPERIENCE_W_FIRST_PARTY', 0.60),
    googleRating: num('EXPERIENCE_W_GOOGLE', 0.30),
    creatorSentiment: num('EXPERIENCE_W_CREATOR_SENTIMENT', 0.10),
  },

  /** Google ratings below this many raters are treated as weak evidence. */
  googleRatingCountTarget: num('EXPERIENCE_GOOGLE_COUNT_TARGET', 50),

  // ── Evidence credit per observation, by source ──────────────────────────
  // Tuned so the floor of 3 is cleared by any ONE of:
  //   - 3 of our own users' ratings
  //   - ~60 Google raters
  //   - 6 creator reviews
  /** One first-party rating is the unit of evidence. */
  firstPartyCredit: num('EXPERIENCE_CREDIT_FIRST_PARTY', 1.0),
  /** Each Google rater counts for a twentieth of a first-party rating. */
  googleRaterCredit: num('EXPERIENCE_CREDIT_GOOGLE_RATER', 0.05),
  /** Cap on total Google credit, so a famous place cannot coast on Google. */
  googleCreditCap: num('EXPERIENCE_CREDIT_GOOGLE_CAP', 5),
  /** Creators self-select for enthusiasm, so they count for half. */
  creatorReviewCredit: num('EXPERIENCE_CREDIT_CREATOR_REVIEW', 0.5),

  /** First-party ratings needed for full first-party confidence. */
  firstPartyCountTarget: num('EXPERIENCE_FIRST_PARTY_COUNT_TARGET', 10),

  /** Experience score (0-100) at or above which we say it lives up to hype. */
  livesUpThreshold: num('EXPERIENCE_LIVES_UP_THRESHOLD', 72),

  /** Below this, and only with enough observations, "below expectations". */
  belowThreshold: num('EXPERIENCE_BELOW_THRESHOLD', 55),

  /**
   * Hype must exceed experience by at least this many points before we call
   * anything overhyped. Prevents a 1-point gap becoming a verdict.
   */
  minGapForVerdict: num('EXPERIENCE_MIN_GAP', 15),
} as const;

export type TrendState = 'ranked' | 'warming_up' | 'insufficient_data';
export type ExperienceState = 'measured' | 'insufficient_data';
export type HypeVsReality =
  | 'lives_up'
  | 'mixed'
  | 'below_expectations'
  | 'insufficient_data';
