/**
 * Dish matching thresholds.
 *
 * Every value is env-overridable, like lib/config/trends.ts, so these can be
 * retuned against observed data without a deploy.
 *
 * THE ASYMMETRY THAT SETS THESE NUMBERS: a false merge and a false split are
 * not equally bad. A false merge makes a visible, wrong claim — "beef taco"
 * absorbing "fish taco" would put them on one trend line and one dish page.
 * A false split costs one extra row and one embedding call (~$0.0000002) and
 * is fixed by adding one alias row. So everything here leans toward splitting.
 *
 * ── MEASURED, NOT GUESSED ───────────────────────────────────────────────────
 *
 * TRIGRAM (rung b) separates cleanly. On real pairs:
 *   must match:      1.000  identical
 *                    0.842  matcha croissant / matcha croissants
 *                    0.786  birria taco / birria tacos
 *                    0.667  smash burger / smashburger
 *   must NOT match:  0.348  chicken sandwich / chicken wings
 *                    0.333  beef taco / fish taco
 *                    0.304  matcha croissant / matcha latte
 *                    0.250  birria tacos / quesabirria
 * A gap from 0.348 to 0.667, so a threshold inside it is safe.
 *
 * EMBEDDINGS (rung c) DO NOT separate. Measured with text-embedding-3-small
 * over twelve pairs and four different input templates (bare name, "menu
 * item: X", "X — a dish or drink served at a restaurant", "I ordered the X"):
 *
 *   template            lowest TRUE match   highest FALSE match
 *   bare name                 0.388               0.814
 *   menu item                 0.636               0.813
 *   with context              0.649               0.867
 *   ordered phrasing          0.710               0.819
 *
 * In every case the lowest true match sits BELOW the highest false match, so
 * no threshold exists that admits the true matches without also admitting
 * false ones. The failure is systematic rather than noisy: cosine similarity
 * on short food phrases tracks shared wording, not culinary identity. Hence
 * "beef taco" vs "fish taco" at 0.709 beating "korean fried chicken" vs "kfc
 * chicken" at 0.599, and "birria tacos" vs "quesabirria" — the exact case
 * this feature was requested for — scoring 0.388, the lowest of all twelve.
 *
 * So rung (c) does not decide. It FLAGS a possible duplicate for review and
 * creates the dish separately. Automatic aliasing is available behind
 * DISH_EMBEDDING_AUTO_ALIAS but defaults off; see the note on that flag.
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

export const DISH_MATCH = {
  /**
   * Trigram threshold for rung (b): 0.62.
   *
   * Inside the measured 0.348-0.667 gap, placed near the upper edge on
   * purpose — a trigram hit merges two dishes with no further check, so this
   * rung has to be the conservative one. Names that fall through cost an
   * embedding call and land in the review queue instead of being merged.
   *
   * NOT Postgres's pg_trgm default of 0.3, which would merge every pair in
   * the "must not match" list in the header.
   */
  trigramThreshold: num('DISH_TRIGRAM_THRESHOLD', 0.62),

  /**
   * Cosine similarity at which two names are reported as the same dish.
   *
   * 0.92 is where the measured data stops producing false positives — but
   * note what that costs: at 0.92 the only pairs that qualify are
   * "matcha croissant / matcha croissants" (0.952) and "smash burger /
   * smashburger" (0.931), and BOTH are already caught by the normalizer's
   * singularisation or by trigram. So this threshold is safe and almost
   * never fires. That is the honest summary of what embeddings add here.
   */
  embeddingSameThreshold: num('DISH_EMBEDDING_SAME', 0.92),

  /**
   * Floor of the review band. Between this and `embeddingSameThreshold` the
   * dish is created and flagged as a possible duplicate.
   *
   * 0.85 is a review-queue threshold, not a correctness one: a human glancing
   * at a short list of candidate duplicates is cheap, so some false
   * positives here are fine.
   */
  embeddingAmbiguousThreshold: num('DISH_EMBEDDING_AMBIGUOUS', 0.85),

  /**
   * Let rung (c) write an alias by itself at or above
   * `embeddingSameThreshold`.
   *
   * DEFAULT OFF, against the original plan, because of the measurements in
   * the header: an automatic merge is a public claim that two dishes are one,
   * and the evidence does not support making that claim automatically. Turn
   * it on only after reviewing what the flag actually surfaces on real data.
   */
  autoAlias: bool('DISH_EMBEDDING_AUTO_ALIAS', false),

  /** Candidates to pull from te_similar_dishes. */
  embeddingMatchCount: num('DISH_EMBEDDING_MATCH_COUNT', 5),

  /**
   * How many existing dish names to hold in memory for trigram comparison.
   * The whole table is read because `dishes` is small by nature — there are
   * only so many dishes people post about — and one bounded read beats a
   * round trip per name.
   */
  trigramCandidateLimit: num('DISH_TRIGRAM_CANDIDATES', 2000),
} as const;

if (DISH_MATCH.embeddingAmbiguousThreshold > DISH_MATCH.embeddingSameThreshold) {
  throw new Error(
    'DISH_EMBEDDING_AMBIGUOUS must be <= DISH_EMBEDDING_SAME, otherwise the review band is inverted'
  );
}

export type DishMatchVerdict = 'same' | 'review' | 'new';

/**
 * Turn a cosine similarity into a decision.
 *
 * Pure, so the check scripts can assert the decision table offline with no
 * API key and no network.
 */
export function classifyEmbeddingSimilarity(similarity: number): DishMatchVerdict {
  if (!Number.isFinite(similarity)) return 'new';
  if (similarity >= DISH_MATCH.embeddingSameThreshold) return 'same';
  if (similarity >= DISH_MATCH.embeddingAmbiguousThreshold) return 'review';
  return 'new';
}
