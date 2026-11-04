/**
 * Trend + experience scoring checks. Run: npx tsx scripts/check-trends.ts
 *
 * These encode the judgement calls, not just the arithmetic. If someone later
 * retunes the weights, these should still hold — and if one starts failing,
 * that is the signal that a change altered behaviour, not just numbers.
 */
import { computeTrendScore, computeHypeScore } from '../lib/trends/score';
import {
  computeExperienceSignal,
  compareHypeToReality,
} from '../lib/experience/signal';

let pass = 0;
let fail = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

const quiet = {
  uniqueSavesCurrent: 0,
  uniqueSavesPrevious: 0,
  submissionsCurrent: 0,
  submissionsPrevious: 0,
  uniqueUsersCurrent: 0,
  uniqueUsersPrevious: 0,
  hoursSinceLastActivity: null,
  observations: 0,
};

// ── The situation today: 4 restaurants, no users ────────────────────────────
const today = computeTrendScore(quiet);
check(
  'no activity -> insufficient_data, not a score of 0',
  today.state === 'insufficient_data' && today.score === null,
  `got state=${today.state} score=${today.score}`
);

// ── One lonely signal is not a trend ───────────────────────────────────────
const oneSave = computeTrendScore({
  ...quiet,
  uniqueSavesCurrent: 1,
  uniqueUsersCurrent: 1,
  hoursSinceLastActivity: 1,
  observations: 1,
});
check(
  '1 observation -> still unranked',
  oneSave.score === null && oneSave.state === 'insufficient_data',
  `got state=${oneSave.state}`
);

// ── Some activity, below the floor -> warming_up, still no number ──────────
const warming = computeTrendScore({
  ...quiet,
  uniqueSavesCurrent: 2,
  uniqueUsersCurrent: 2,
  submissionsCurrent: 1,
  hoursSinceLastActivity: 4,
  observations: 3,
});
check(
  '3 observations -> warming_up with a null score',
  warming.state === 'warming_up' && warming.score === null,
  `got state=${warming.state} score=${warming.score}`
);

// ── Over the floor -> ranked with a real number ────────────────────────────
const activeInput = {
  uniqueSavesCurrent: 12,
  uniqueSavesPrevious: 3,
  submissionsCurrent: 4,
  submissionsPrevious: 1,
  uniqueUsersCurrent: 14,
  uniqueUsersPrevious: 5,
  hoursSinceLastActivity: 2,
  observations: 30,
};
const ranked = computeTrendScore(activeInput);
check(
  'real activity -> ranked with a score in 0..100',
  ranked.state === 'ranked' &&
    ranked.score !== null &&
    ranked.score > 0 &&
    ranked.score <= 100,
  `got state=${ranked.state} score=${ranked.score}`
);

// ── Volume weighting: percentage growth must not beat real volume ──────────
// A: 0 -> 1 save. "Infinite" growth, one data point.
// B: 20 -> 40 saves. 2x growth, forty data points.
const tiny = computeTrendScore({
  uniqueSavesCurrent: 1,
  uniqueSavesPrevious: 0,
  submissionsCurrent: 1,
  submissionsPrevious: 0,
  uniqueUsersCurrent: 1,
  uniqueUsersPrevious: 0,
  hoursSinceLastActivity: 1,
  observations: 5,
});
const big = computeTrendScore({
  uniqueSavesCurrent: 40,
  uniqueSavesPrevious: 20,
  submissionsCurrent: 6,
  submissionsPrevious: 3,
  uniqueUsersCurrent: 40,
  uniqueUsersPrevious: 20,
  hoursSinceLastActivity: 1,
  observations: 60,
});
check(
  '40 saves outranks 1 save despite lower % growth',
  (big.score ?? 0) > (tiny.score ?? 0),
  `1-save score=${tiny.score}, 40-save score=${big.score}`
);

// ── Recency decays ─────────────────────────────────────────────────────────
const fresh = computeTrendScore({ ...activeInput, hoursSinceLastActivity: 1 });
const stale = computeTrendScore({ ...activeInput, hoursSinceLastActivity: 480 });
check(
  'stale activity scores lower than fresh',
  (fresh.score ?? 0) > (stale.score ?? 0),
  `fresh=${fresh.score} stale=${stale.score}`
);

// ── Hype score is a level, not a growth rate ───────────────────────────────
check(
  'hype score rises with accumulated attention',
  computeHypeScore({ reviewCount: 8, savesCount: 40, uniqueUsers: 40 }) >
    computeHypeScore({ reviewCount: 1, savesCount: 2, uniqueUsers: 2 }),
  'hype did not increase with attention'
);

// ── EXPERIENCE: the exact bug being fixed ──────────────────────────────────
// Misk Iraqi today: zero reviews, zero feedback, no Google count.
const noEvidence = computeExperienceSignal({
  firstPartyRatings: [],
  googleRating: null,
  googleRatingCount: null,
  creatorSentiment: null,
  creatorReviewCount: 0,
});
check(
  'no evidence -> insufficient_data, score null (NOT 0)',
  noEvidence.state === 'insufficient_data' && noEvidence.score === null,
  `got state=${noEvidence.state} score=${noEvidence.score}`
);

// ── A single bad rating must not produce a negative verdict ────────────────
const oneBadRating = computeExperienceSignal({
  firstPartyRatings: [1],
  googleRating: null,
  googleRatingCount: null,
  creatorSentiment: null,
  creatorReviewCount: 0,
});
const oneBadVerdict = compareHypeToReality(90, oneBadRating);
check(
  'one 1-star rating does not yield "below_expectations"',
  oneBadVerdict.verdict !== 'below_expectations',
  `got verdict=${oneBadVerdict.verdict}`
);

// ── With enough evidence, a negative verdict IS allowed ───────────────────
const manyBad = computeExperienceSignal({
  firstPartyRatings: [1, 2, 2, 1, 2, 1, 2],
  googleRating: 2.6,
  googleRatingCount: 120,
  creatorSentiment: 0.9,
  creatorReviewCount: 6,
});
const negativeVerdict = compareHypeToReality(95, manyBad);
check(
  'sustained negative evidence + big gap -> below_expectations',
  negativeVerdict.verdict === 'below_expectations',
  `got verdict=${negativeVerdict.verdict} score=${manyBad.score} obs=${manyBad.observations}`
);

// ── Good experience -> lives_up ───────────────────────────────────────────
const good = computeExperienceSignal({
  firstPartyRatings: [5, 4, 5, 5, 4],
  googleRating: 4.8,
  googleRatingCount: 400,
  creatorSentiment: 0.9,
  creatorReviewCount: 3,
});
check(
  'strong positive evidence -> lives_up',
  compareHypeToReality(80, good).verdict === 'lives_up',
  `got verdict=${compareHypeToReality(80, good).verdict} score=${good.score}`
);

// ── Thin Google-only evidence should not become authoritative ──────────────
const thinGoogle = computeExperienceSignal({
  firstPartyRatings: [],
  googleRating: 5.0,
  googleRatingCount: 3,
  creatorSentiment: null,
  creatorReviewCount: 0,
});
check(
  '3 Google raters alone stays insufficient',
  thinGoogle.state === 'insufficient_data',
  `got state=${thinGoogle.state} obs=${thinGoogle.observations}`
);

// ── Bartholomew Bakery, as it exists in production right now ──────────────
const bartholomew = computeExperienceSignal({
  firstPartyRatings: [],
  googleRating: 4.8,
  googleRatingCount: 500,
  creatorSentiment: 0.9,
  creatorReviewCount: 3,
});
check(
  'Bartholomew (4.8 Google, 3 creator reviews) -> measured',
  bartholomew.state === 'measured' && bartholomew.score !== null,
  `got state=${bartholomew.state} score=${bartholomew.score}`
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
