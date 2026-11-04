/**
 * Normalization checks. Run: npx tsx scripts/check-dishes.ts
 *
 * These are the cases that matter for Viral Dishes to be meaningful at all:
 * surface variants must merge, distinct dishes must stay distinct.
 */
import {
  normalizeDishName,
  classifyDish,
  dedupeAndCount,
} from '../lib/dishes/normalize';
import { trigramSimilarity, bestTrigramMatch } from '../lib/dishes/similarity';
import { DISH_MATCH, classifyEmbeddingSimilarity } from '../lib/config/dishes';

let pass = 0;
let fail = 0;

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL  ${label}\n      expected ${e}\n      actual   ${a}`);
  }
}

// ── Surface variants must collapse ──────────────────────────────────────────
const croissantVariants = [
  'Matcha Croissant', 'matcha croissants', 'MATCHA CROISSANT',
  'the matcha croissant', 'their famous matcha croissants', ' matcha  croissant ',
];
const normalizedCroissants = new Set(croissantVariants.map(normalizeDishName));
eq([...normalizedCroissants], ['matcha croissant'], 'matcha croissant variants collapse to one');

// ── Distinct dishes must NOT collapse ───────────────────────────────────────
eq(
  normalizeDishName('matcha latte') !== normalizeDishName('matcha croissant'),
  true,
  'matcha latte stays distinct from matcha croissant'
);
eq(
  normalizeDishName('korean fried chicken') !== normalizeDishName('fried chicken'),
  true,
  'korean fried chicken stays distinct from fried chicken'
);

// ── Plurals ─────────────────────────────────────────────────────────────────
eq(normalizeDishName('pastries'), 'pastry', 'pastries -> pastry');
eq(normalizeDishName('sandwiches'), 'sandwich', 'sandwiches -> sandwich');
eq(normalizeDishName('burgers'), 'burger', 'burgers -> burger');
eq(normalizeDishName('hummus'), 'hummus', 'hummus is not de-pluralized');

// ── The real bug from your live data: smart vs straight apostrophe ──────────
const live = [
  "line longer than you'd expect",
  'line longer than you’d expect',
  "line longer than you'd expect",
];
eq(dedupeAndCount(live).length, 1, 'smart-quote duplicates merge into one item');
eq(dedupeAndCount(live)[0].count, 3, 'merged item keeps the full count of 3');

// ── Your live top_dishes should classify ────────────────────────────────────
eq(classifyDish('pastries')?.family, 'pastry', 'pastries -> pastry family');
eq(classifyDish('breads')?.family, 'bread', 'breads -> bread family');
eq(
  classifyDish('sandwiches on house made focaccia')?.family,
  'sandwich',
  'focaccia sandwich -> sandwich family'
);
eq(classifyDish('smash burger')?.family, 'smash-burger', 'smash burger has own family');
eq(classifyDish('matcha latte')?.family, 'matcha', 'matcha latte -> matcha family');
eq(classifyDish('korean fried chicken')?.family, 'korean-fried-chicken', 'KFC family');

// ── Garbage must be rejected, not stored as a dish ──────────────────────────
eq(normalizeDishName(''), '', 'empty string rejected');
eq(normalizeDishName('the'), '', 'bare article rejected');
eq(normalizeDishName('123'), '', 'bare number rejected');
eq(
  normalizeDishName('i went here last tuesday and the service was really quite slow'),
  '',
  'a whole sentence is rejected, not stored as a dish'
);

// ── Accented names ─────────────────────────────────────────────────────────
// These were broken before the NFD fold: the [^a-z0-9] filter turned every
// accented letter into a space, so "crème brûlée" normalized to "cr me br l e"
// with the slug "crme-brle" — a dish at a nonsense URL that could never group
// with the unaccented spelling people actually type.
eq(
  normalizeDishName('Crème Brûlée'),
  normalizeDishName('creme brulee'),
  'accented and unaccented creme brulee normalize the same'
);
eq(classifyDish('Crème Brûlées')?.slug, 'creme-brulee', 'accented name gets a clean slug');
eq(classifyDish('Bánh Mì')?.slug, 'banh-mi', 'banh mi keeps both syllables');
eq(classifyDish('açaí bowls')?.slug, 'acai-bowl', 'acai bowl survives two accents');
eq(classifyDish('Jalapeño Poppers')?.slug, 'jalapeno-popper', 'jalapeno keeps its n');

// ── Trigram rung of the resolve ladder ─────────────────────────────────────
// The threshold has to sit inside the measured gap between real matches and
// false ones. These assertions fail if someone moves it out of that gap.
const MUST_MATCH: Array<[string, string]> = [
  ['matcha croissant', 'matcha croissants'],
  ['birria taco', 'birria tacos'],
  ['smash burger', 'smashburger'],
];
const MUST_NOT_MATCH: Array<[string, string]> = [
  ['matcha croissant', 'matcha latte'],
  ['birria tacos', 'quesabirria'],
  ['chicken sandwich', 'chicken wings'],
  ['beef taco', 'fish taco'],
  ['fried chicken', 'fried rice'],
  ['iced latte', 'iced tea'],
];

for (const [a, b] of MUST_MATCH) {
  eq(
    trigramSimilarity(a, b) >= DISH_MATCH.trigramThreshold,
    true,
    `trigram merges "${a}" with "${b}" (${trigramSimilarity(a, b).toFixed(3)})`
  );
}
for (const [a, b] of MUST_NOT_MATCH) {
  eq(
    trigramSimilarity(a, b) >= DISH_MATCH.trigramThreshold,
    false,
    `trigram keeps "${a}" apart from "${b}" (${trigramSimilarity(a, b).toFixed(3)})`
  );
}

// The gap itself. If a future change narrows it, the threshold is no longer
// safely placed and that should be a visible failure, not a surprise merge.
const lowestTrue = Math.min(...MUST_MATCH.map(([a, b]) => trigramSimilarity(a, b)));
const highestFalse = Math.max(...MUST_NOT_MATCH.map(([a, b]) => trigramSimilarity(a, b)));
eq(highestFalse < lowestTrue, true, 'trigram scores for real and false matches do not overlap');
eq(
  DISH_MATCH.trigramThreshold > highestFalse &&
    DISH_MATCH.trigramThreshold <= lowestTrue,
  true,
  `trigram threshold ${DISH_MATCH.trigramThreshold} sits inside the gap ` +
    `(${highestFalse.toFixed(3)} .. ${lowestTrue.toFixed(3)})`
);

eq(trigramSimilarity('taco', 'ocat'), trigramSimilarity('ocat', 'taco'), 'trigram similarity is symmetric');
eq(trigramSimilarity('', 'taco'), 0, 'an empty name matches nothing');

// bestTrigramMatch must pick the closest candidate, not the first one over
// the line — otherwise "matcha croissants" could attach to whichever matcha
// dish happens to be earliest in the table.
const picked = bestTrigramMatch('matcha croissant', [
  { id: 'a', slug: 'matcha-latte', name: 'matcha latte' },
  { id: 'b', slug: 'matcha-croissant', name: 'matcha croissant' },
  { id: 'c', slug: 'croissant', name: 'croissant' },
]);
eq(picked?.id, 'b', 'bestTrigramMatch returns the closest candidate');
eq(
  bestTrigramMatch('quesabirria', [{ id: 'a', slug: 'birria-taco', name: 'birria taco' }]),
  null,
  'bestTrigramMatch returns null when nothing clears the threshold'
);

// ── Embedding verdict table ────────────────────────────────────────────────
// Pure decision logic, asserted without an API key or a network.
eq(classifyEmbeddingSimilarity(0.99), 'same', '0.99 is the same dish');
eq(classifyEmbeddingSimilarity(DISH_MATCH.embeddingSameThreshold), 'same', 'the same-threshold is inclusive');
eq(classifyEmbeddingSimilarity(0.88), 'review', '0.88 goes to the review queue');
eq(
  classifyEmbeddingSimilarity(DISH_MATCH.embeddingAmbiguousThreshold),
  'review',
  'the review-threshold is inclusive'
);
eq(classifyEmbeddingSimilarity(0.5), 'new', '0.5 is a different dish');
eq(classifyEmbeddingSimilarity(NaN), 'new', 'a NaN similarity never merges');
eq(classifyEmbeddingSimilarity(0.388), 'new', 'birria/quesabirria at its measured 0.388 is not a merge');

// Automatic merging must stay off by default. Turning it on is a decision to
// publish claims that two dishes are one, and the measurements in
// lib/config/dishes.ts do not support making it automatically.
eq(DISH_MATCH.autoAlias, false, 'embedding auto-alias is off by default');

// ── What embeddings cannot do, recorded on purpose ─────────────────────────
// The plan expected embeddings to catch "birria tacos" ~ "quesabirria".
// Measured with text-embedding-3-small that pair scores 0.388, below pairs of
// genuinely different dishes, and no input template separated true from false
// matches. The mechanism that DOES handle real synonyms is one row in
// dish_aliases, and these two names normalizing to different slugs is what
// makes such a row necessary.
eq(
  classifyDish('birria tacos')?.slug !== classifyDish('quesabirria')?.slug,
  true,
  'birria tacos and quesabirria are separate dishes until an alias says otherwise'
);
eq(
  classifyDish('matcha croissant')?.slug !== classifyDish('matcha latte')?.slug,
  true,
  'matcha croissant and matcha latte stay separate dishes'
);


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
