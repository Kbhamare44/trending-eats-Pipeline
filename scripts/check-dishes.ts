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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
