/**
 * LIVE embedding checks. Costs real OpenAI calls, so it is NOT part of
 * `npm run check`, which stays offline.
 *
 *   npm run check:embeddings
 *
 * This exists to keep an uncomfortable measurement from being quietly
 * forgotten. Embeddings were added to the dish matcher to catch synonyms that
 * spelling cannot — "birria tacos" and "quesabirria" being the motivating
 * example. They do not do that. On text-embedding-3-small that pair scores
 * around 0.39, below pairs of genuinely different dishes, and four different
 * input templates all left the lowest true match below the highest false
 * match.
 *
 * The risk this guards against is somebody seeing the review queue stay empty
 * and "fixing" it by lowering DISH_EMBEDDING_SAME until birria matches —
 * which would also merge beef tacos with fish tacos, and matcha croissants
 * with matcha lattes, and publish all of it. This run fails if the configured
 * threshold would admit any of the pairs below that must stay separate.
 */

import {
  embedBatch,
  dishEmbeddingInput,
  isEmbeddingConfigured,
  EMBEDDING_MODEL_TAG,
} from '../lib/openai/client';
import { cosineSimilarity } from '../lib/dishes/similarity';
import { DISH_MATCH, classifyEmbeddingSimilarity } from '../lib/config/dishes';
import { normalizeDishName } from '../lib/dishes/normalize';

/** [a, b, areTheSameDish] */
const PAIRS: Array<[string, string, boolean]> = [
  // Same dish, different wording.
  ['birria tacos', 'quesabirria', true],
  ['bubble tea', 'boba', true],
  ['korean fried chicken', 'kfc chicken', true],
  ['smash burger', 'smashburger', true],
  ['matcha croissant', 'matcha croissants', true],
  ['ramen', 'tonkotsu ramen', true],
  // Genuinely different dishes. Merging any of these is a visible, wrong
  // public claim about a restaurant's menu.
  ['beef taco', 'fish taco', false],
  ['matcha croissant', 'matcha latte', false],
  ['chicken sandwich', 'chicken wings', false],
  ['fried chicken', 'fried rice', false],
  ['creme brulee', 'burnt basque cheesecake', false],
  ['iced latte', 'iced tea', false],
];

let pass = 0;
let fail = 0;

function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL  ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
  }
}

async function main() {
  if (!isEmbeddingConfigured()) {
    console.error('OPENAI_API_KEY is not set — skipping live embedding checks.');
    process.exit(1);
  }

  const names = [...new Set(PAIRS.flatMap(([a, b]) => [a, b]))];
  const vectors = await embedBatch(
    names.map((n) => dishEmbeddingInput(normalizeDishName(n) || n))
  );
  const byName = new Map(names.map((n, i) => [n, vectors[i]]));

  console.log(`model: ${EMBEDDING_MODEL_TAG}  dimensions: ${vectors[0].length}\n`);

  const scored = PAIRS.map(([a, b, same]) => ({
    a,
    b,
    same,
    similarity: cosineSimilarity(byName.get(a)!, byName.get(b)!),
    verdict: classifyEmbeddingSimilarity(cosineSimilarity(byName.get(a)!, byName.get(b)!)),
  })).sort((x, y) => y.similarity - x.similarity);

  console.log('A'.padEnd(22) + 'B'.padEnd(25) + 'cosine'.padStart(7) + '  truth   verdict');
  for (const row of scored) {
    console.log(
      row.a.padEnd(22) +
        row.b.padEnd(25) +
        row.similarity.toFixed(3).padStart(7) +
        '  ' +
        (row.same ? 'SAME  ' : 'differ') +
        '  ' +
        row.verdict
    );
  }
  console.log();

  check('every vector has the declared dimension', vectors.every((v) => v.length === 1536), true);

  // THE LOAD-BEARING ASSERTION. No pair of genuinely different dishes may be
  // classified as the same at the configured threshold.
  const wrongMerges = scored.filter((r) => !r.same && r.verdict === 'same');
  check(
    `no different dishes are merged at DISH_EMBEDDING_SAME=${DISH_MATCH.embeddingSameThreshold}` +
      (wrongMerges.length ? ` (would merge: ${wrongMerges.map((r) => `${r.a}/${r.b}`).join(', ')})` : ''),
    wrongMerges.length,
    0
  );

  // Record the overlap rather than asserting it away. If a future model
  // actually separates these, this check turns into a prompt to revisit the
  // design — which is the useful outcome either way.
  const lowestTrue = Math.min(...scored.filter((r) => r.same).map((r) => r.similarity));
  const highestFalse = Math.max(...scored.filter((r) => !r.same).map((r) => r.similarity));
  const separable = lowestTrue > highestFalse;

  console.log(
    `lowest TRUE match ${lowestTrue.toFixed(3)} | highest FALSE match ${highestFalse.toFixed(3)} | ` +
      (separable
        ? 'SEPARABLE — a single threshold now works, revisit lib/config/dishes.ts'
        : 'overlapping — as documented, embeddings cannot decide sameness here')
  );

  // Identical strings must be identical vectors; if this fails the client is
  // misaligning responses to inputs, which no other check would catch.
  const [v1, v2] = await embedBatch(['matcha croissant', 'matcha croissant']);
  check('the same input embeds identically', cosineSimilarity(v1, v2) > 0.9999, true);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
