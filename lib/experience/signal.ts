/**
 * Experience Signal — the "reality" half of Hype vs Reality.
 *
 * Kept strictly separate from popularity. Popularity says how much attention
 * a place is getting; this says what customers actually reported. The two are
 * displayed side by side and never blended into one star rating.
 *
 * Two rules are load-bearing and should not be relaxed casually:
 *
 *   1. No data is NOT bad data. Below `minObservations` the score is null and
 *      the state is 'insufficient_data'. This is the bug we are fixing: today
 *      Misk Iraqi and NAAN KABOB carry authenticity_score = 0 with zero
 *      reviews, which reads to a user as "this place is terrible" when what we
 *      actually know is nothing at all.
 *
 *   2. A negative verdict needs MORE evidence than a positive one. These are
 *      real businesses whose livelihood can be affected by what this app says
 *      about them, so 'below_expectations' requires
 *      `minObservationsForNegative` independent observations AND a meaningful
 *      gap. Otherwise the verdict is 'mixed' or 'insufficient_data'.
 */

import {
  EXPERIENCE_CONFIG,
  ExperienceState,
  HypeVsReality,
} from '@/lib/config/trends';

export interface ExperienceInput {
  /** Our own users' 1-5 ratings. */
  firstPartyRatings: number[];
  /** Google Places rating 1-5, displayed under Google's terms with attribution. */
  googleRating: number | null;
  /** How many raters Google reports — weak evidence if tiny. */
  googleRatingCount: number | null;
  /**
   * Mean creator sentiment from analyzed TikTok captions, -1..1.
   * Lowest weight: creators self-select for enthusiasm and some are sponsored.
   */
  creatorSentiment: number | null;
  /** How many creator reviews that sentiment is based on. */
  creatorReviewCount: number;
}

export interface ExperienceInputBreakdown {
  source: 'first_party' | 'google' | 'creator_sentiment';
  /** Normalized to 0..100 so the sources are comparable. */
  value: number;
  /** Raw observation count for this source — what we show the user. */
  observations: number;
  /**
   * Evidence credit this source contributes toward the minimum-evidence
   * floor. Deliberately not equal to `observations`: see EXPERIENCE_CONFIG.
   */
  credit: number;
  /** Effective weight after confidence scaling. */
  weight: number;
  /** What the app shows as the source label. */
  label: string;
}

export interface ExperienceResult {
  /** 0..100, or null when state is 'insufficient_data'. */
  score: number | null;
  state: ExperienceState;
  confidence: number;
  /** Raw observation count across all sources — for display. */
  observations: number;
  /** Credit-weighted evidence total — what the floors are checked against. */
  credit: number;
  /** First-party reports only. The strongest evidence we have. */
  firstPartyObservations: number;
  inputs: ExperienceInputBreakdown[];
  explanation: string;
}

export interface HypeVsRealityResult {
  verdict: HypeVsReality;
  /** hype - experience, in points. null when either side is unknown. */
  gap: number | null;
  /** Plain-language line the app renders. Never asserts more than we know. */
  summary: string;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** 1-5 star rating -> 0..100. */
function starsTo100(stars: number): number {
  return clamp(((stars - 1) / 4) * 100, 0, 100);
}

/** -1..1 sentiment -> 0..100. */
function sentimentTo100(sentiment: number): number {
  return clamp(((sentiment + 1) / 2) * 100, 0, 100);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function computeExperienceSignal(
  input: ExperienceInput
): ExperienceResult {
  const inputs: ExperienceInputBreakdown[] = [];
  const w = EXPERIENCE_CONFIG.weights;

  // ── First-party feedback: our users, highest trust ───────────────────────
  if (input.firstPartyRatings.length > 0) {
    const avgStars = mean(input.firstPartyRatings);
    const count = input.firstPartyRatings.length;
    const confidence = clamp(
      count / EXPERIENCE_CONFIG.firstPartyCountTarget,
      0,
      1
    );
    inputs.push({
      source: 'first_party',
      value: starsTo100(avgStars),
      observations: count,
      credit: count * EXPERIENCE_CONFIG.firstPartyCredit,
      weight: w.firstParty * confidence,
      label: `${count} ${count === 1 ? 'rating' : 'ratings'} from Trending Eats users`,
    });
  }

  // ── Google Places rating, shown with attribution ─────────────────────────
  if (input.googleRating !== null && input.googleRating > 0) {
    const raterCount = input.googleRatingCount ?? 0;
    const confidence =
      raterCount > 0
        ? clamp(raterCount / EXPERIENCE_CONFIG.googleRatingCountTarget, 0, 1)
        : 0.4; // rating present but count unknown: partial credit
    inputs.push({
      source: 'google',
      value: starsTo100(input.googleRating),
      observations: raterCount,
      // Each Google rater is worth a fraction of a first-hand report, and the
      // total is capped, so neither a 3-rater 5.0 nor a 10,000-rater chain can
      // single-handedly decide the verdict.
      credit: Math.min(
        raterCount * EXPERIENCE_CONFIG.googleRaterCredit,
        EXPERIENCE_CONFIG.googleCreditCap
      ),
      weight: w.googleRating * confidence,
      label: raterCount
        ? `${input.googleRating.toFixed(1)} on Google (${raterCount} reviews)`
        : `${input.googleRating.toFixed(1)} on Google`,
    });
  }

  // ── Creator sentiment, lowest weight ─────────────────────────────────────
  if (input.creatorSentiment !== null && input.creatorReviewCount > 0) {
    const confidence = clamp(input.creatorReviewCount / 5, 0, 1);
    inputs.push({
      source: 'creator_sentiment',
      value: sentimentTo100(input.creatorSentiment),
      observations: input.creatorReviewCount,
      credit: input.creatorReviewCount * EXPERIENCE_CONFIG.creatorReviewCredit,
      weight: w.creatorSentiment * confidence,
      label: `${input.creatorReviewCount} creator ${
        input.creatorReviewCount === 1 ? 'review' : 'reviews'
      }`,
    });
  }

  const totalObservations = inputs.reduce((sum, i) => sum + i.observations, 0);
  const totalCredit =
    Math.round(inputs.reduce((sum, i) => sum + i.credit, 0) * 100) / 100;
  const totalWeight = inputs.reduce((sum, i) => sum + i.weight, 0);
  const firstPartyObservations =
    inputs.find((i) => i.source === 'first_party')?.observations ?? 0;

  if (
    inputs.length === 0 ||
    totalWeight <= 0 ||
    totalCredit < EXPERIENCE_CONFIG.minObservations
  ) {
    return {
      score: null,
      state: 'insufficient_data',
      confidence: clamp(totalCredit / EXPERIENCE_CONFIG.minObservations, 0, 1),
      observations: totalObservations,
      credit: totalCredit,
      firstPartyObservations,
      inputs,
      explanation:
        inputs.length === 0
          ? 'Not enough first-hand reports yet. Be the first to tell us how it was.'
          : `Only ${inputs
              .map((i) => i.label)
              .join(' and ')} so far — not enough to score the experience yet.`,
    };
  }

  const weighted =
    inputs.reduce((sum, i) => sum + i.value * i.weight, 0) / totalWeight;

  return {
    score: Math.round(weighted * 10) / 10,
    state: 'measured',
    confidence: clamp(totalWeight / (w.firstParty + w.googleRating), 0, 1),
    observations: totalObservations,
    credit: totalCredit,
    firstPartyObservations,
    inputs,
    explanation: `Based on ${inputs.map((i) => i.label).join(', ')}.`,
  };
}

/**
 * Compare attention against reported experience.
 *
 * Returns 'insufficient_data' unless BOTH sides are known. 'below_expectations'
 * additionally requires the higher negative-evidence bar and a gap of at least
 * `minGapForVerdict` points.
 */
export function compareHypeToReality(
  hypeScore: number | null,
  experience: ExperienceResult
): HypeVsRealityResult {
  if (
    hypeScore === null ||
    experience.state !== 'measured' ||
    experience.score === null
  ) {
    return {
      verdict: 'insufficient_data',
      gap: null,
      summary:
        'We track popularity and customer experience separately. There is not enough experience data here yet to compare them.',
    };
  }

  const gap = Math.round((hypeScore - experience.score) * 10) / 10;

  const evidence = experience.inputs.map((i) => i.label).join(' and ');

  // Clearly good experience -> it lives up, regardless of hype level.
  if (experience.score >= EXPERIENCE_CONFIG.livesUpThreshold) {
    return {
      verdict: 'lives_up',
      gap,
      summary: `People who went were happy — ${experience.score.toFixed(
        0
      )}/100 based on ${evidence}.`,
    };
  }

  // The negative bar is checked against CREDIT, so a verdict cannot be
  // reached on a pile of weak observations.
  const negativeEvidenceMet =
    experience.credit >= EXPERIENCE_CONFIG.minObservationsForNegative;
  const gapIsMeaningful = gap >= EXPERIENCE_CONFIG.minGapForVerdict;
  const scoreIsLow = experience.score < EXPERIENCE_CONFIG.belowThreshold;

  if (negativeEvidenceMet && gapIsMeaningful && scoreIsLow) {
    return {
      verdict: 'below_expectations',
      gap,
      summary: `Getting more attention than its reviews support — ${experience.score.toFixed(
        0
      )}/100 based on ${evidence}.`,
    };
  }

  // Low score but thin evidence: say so plainly rather than implying a verdict.
  if (scoreIsLow && !negativeEvidenceMet) {
    return {
      verdict: 'insufficient_data',
      gap,
      summary: `Early reports are mixed, but with only ${evidence} we are not drawing a conclusion yet.`,
    };
  }

  return {
    verdict: 'mixed',
    gap,
    summary: `Reviews are mixed — ${experience.score.toFixed(
      0
    )}/100 based on ${evidence}.`,
  };
}
