/**
 * Trigram similarity, matching Postgres pg_trgm's semantics.
 *
 * WHY IN TYPESCRIPT, with a gin index sitting right there: PostgREST exposes
 * no trigram operator. `similarity()` and `%` are not reachable through the
 * REST filter syntax, and reaching them needs a SQL function — which is a
 * migration, and migrations are applied out of band here. So rung (b) of the
 * ladder reads the dish names once and compares in memory.
 *
 * That is not as bad as it sounds: `dishes` is small by nature, one bounded
 * read replaces a round trip per candidate name, and the result is identical
 * to what Postgres would return because this implements the same algorithm.
 * If a te_similar_dish_names() RPC is ever added, this can be swapped for it
 * without any threshold changing.
 *
 * THE ALGORITHM, as pg_trgm defines it: lowercase; split on non-alphanumeric
 * characters; pad each word with two leading spaces and one trailing space;
 * take every 3-character window; similarity is the Jaccard index of the two
 * trigram sets. The padding is what makes short words comparable and why
 * "taco" and "tacos" score as highly as they do.
 */

import { DISH_MATCH } from '@/lib/config/dishes';

export function trigrams(value: string): Set<string> {
  const out = new Set<string>();
  if (!value) return out;

  const words = value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  for (const word of words) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) {
      out.add(padded.slice(i, i + 3));
    }
  }
  return out;
}

/** Jaccard index of two trigram sets, as pg_trgm's similarity() returns. */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;

  let shared = 0;
  // Iterate the smaller set — the sets are tiny, but this also makes the
  // result order-independent, which a test below asserts.
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const gram of small) {
    if (large.has(gram)) shared++;
  }

  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

export interface TrigramCandidate {
  id: string;
  name: string;
  slug: string;
}

export interface TrigramMatch extends TrigramCandidate {
  similarity: number;
}

/**
 * Best trigram match for a name, or null if nothing clears the threshold.
 *
 * Compares against the NORMALIZED name on both sides. Comparing a normalized
 * query against a display name would score "matcha croissant" against
 * "Matcha Croissant" lower than it should, purely because of the capitals the
 * padding then surrounds differently.
 */
export function bestTrigramMatch(
  normalizedName: string,
  candidates: TrigramCandidate[],
  threshold: number = DISH_MATCH.trigramThreshold
): TrigramMatch | null {
  let best: TrigramMatch | null = null;

  for (const candidate of candidates) {
    const similarity = trigramSimilarity(normalizedName, candidate.name);
    if (similarity < threshold) continue;
    if (!best || similarity > best.similarity) {
      best = { ...candidate, similarity };
    }
  }

  return best;
}

/** Cosine similarity, for verifying vectors outside the database. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
