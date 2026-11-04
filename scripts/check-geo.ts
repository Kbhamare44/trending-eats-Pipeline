/**
 * GTA classification checks against the rows actually in production.
 * Run: npx tsx scripts/check-geo.ts
 */
import { isGta, gtaRegion, resolveGtaCity } from '../lib/geo/gta';

let pass = 0;
let fail = 0;

function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL  ${label}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── The four restaurants currently in the database ─────────────────────────
const live = [
  { name: 'Bartholomew Bakery', city: 'Vaughan',  address: '467 Edgeley Blvd #14, Vaughan, ON L4K 4E9, Canada' },
  { name: 'Supreme Pizzeria',   city: 'Ottawa',   address: '425 Donald St, Ottawa, ON K1K 3M7, Canada' },
  { name: 'Misk Iraqi',         city: 'Vaughan',  address: '4555 Hwy 7 Unit 19, Woodbridge, ON L4L 4Y7, Canada' },
];

check('Bartholomew (Vaughan) is in the GTA', isGta(live[0].city, live[0].address), true);
check('Bartholomew region', gtaRegion(live[0].city, live[0].address), 'York');

// Ottawa is 400km away. It must be excluded, or GTA trending is meaningless.
check('Supreme Pizzeria (Ottawa) is NOT in the GTA', isGta(live[1].city, live[1].address), false);
check('Ottawa has no region', gtaRegion(live[1].city, live[1].address), null);

// Woodbridge address, Vaughan locality — must resolve to Vaughan either way.
check('Misk Iraqi (Woodbridge addr) is in the GTA', isGta(live[2].city, live[2].address), true);
check('Woodbridge resolves to Vaughan', resolveGtaCity('Woodbridge')?.name, 'Vaughan');

// ── Neighbourhood names Google Places returns as the locality ─────────────
check('Scarborough -> Toronto', resolveGtaCity('Scarborough')?.name, 'Toronto');
check('Etobicoke -> Toronto', resolveGtaCity('Etobicoke')?.name, 'Toronto');
check('North York -> Toronto', resolveGtaCity('North York')?.name, 'Toronto');
check('Thornhill -> Vaughan', resolveGtaCity('Thornhill')?.name, 'Vaughan');
check('Unionville -> Markham', resolveGtaCity('Unionville')?.name, 'Markham');
check('Port Credit -> Mississauga', resolveGtaCity('Port Credit')?.name, 'Mississauga');
check('Malton -> Mississauga', resolveGtaCity('Malton')?.name, 'Mississauga');

// ── Longest-alias-wins: "Richmond Hill" must not match a shorter alias ────
check('Richmond Hill resolves correctly', resolveGtaCity('Richmond Hill')?.name, 'Richmond Hill');
check('Richmond Hill region', gtaRegion('Richmond Hill'), 'York');

// ── Regions ───────────────────────────────────────────────────────────────
check('Mississauga -> Peel', gtaRegion('Mississauga'), 'Peel');
check('Oshawa -> Durham', gtaRegion('Oshawa'), 'Durham');
check('Oakville -> Halton', gtaRegion('Oakville'), 'Halton');
check('Markham -> York', gtaRegion('Markham'), 'York');
check('Toronto -> Toronto', gtaRegion('Toronto'), 'Toronto');

// ── Out of market ─────────────────────────────────────────────────────────
check('Hamilton is out of market', isGta('Hamilton'), false);
check('Montreal is out of market', isGta('Montreal'), false);
check('empty input is out of market', isGta(null, null), false);
check('Vancouver is out of market', isGta('Vancouver', '123 Main St, Vancouver, BC'), false);

// ── Near-miss substring traps ─────────────────────────────────────────────
// Each of these contains a GTA alias as a substring but is NOT in the GTA.
check('Hamilton (contains "milton") is out of market', isGta('Hamilton'), false);
check('Brockville (contains "brock") is out of market', isGta('Brockville'), false);
check('New York (contains "york") is out of market', isGta('New York'), false);
check('Actonvale (contains "acton") is out of market', isGta('Actonvale'), false);
check('Miltonville is out of market', isGta('Miltonville'), false);

// Hamilton genuinely borders the GTA, so getting this wrong is not academic.
check('Hamilton has no region', gtaRegion('Hamilton', '100 King St W, Hamilton, ON'), null);

// ── TS and SQL must agree ─────────────────────────────────────────────────
// lib/geo/gta.ts and migration 004's te_is_gta() classify the same rows. If
// they drift, the app and the database disagree about what is in market —
// restaurants would show on the map but vanish from trending, or vice versa.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GTA_CITIES } from '../lib/geo/gta';

const migration = readFileSync(
  join(__dirname, '../supabase/migrations/20261103_004_gta_and_rls.sql'),
  'utf8'
);

// Pull the alternation contents out of te_is_gta's regex. Done by slicing
// between the \y( and )\y anchors and stripping SQL string-concat syntax,
// rather than a clever regex — a character class is what broke this check
// the first time, on the hyphen in "whitchurch-stouffville".
const isGtaBody = migration.slice(
  migration.indexOf('function te_is_gta'),
  migration.indexOf('function te_gta_region')
);
const start = isGtaBody.indexOf("'\\y(");
const end = isGtaBody.indexOf(")\\y'");
const alternation = isGtaBody
  .slice(start + 4, end)
  .replace(/'\s*\|\|\s*'/g, '')   // join the concatenated string literals
  .replace(/[\r\n]/g, '')
  .trim();

const sqlAliases = new Set(
  alternation
    .split('|')
    .map((a) => a.trim())
    .filter(Boolean)
);

const tsAliases = new Set(
  GTA_CITIES.flatMap((c) => [c.name.toLowerCase(), ...c.aliases])
);

const missingFromSql = [...tsAliases].filter((a) => !sqlAliases.has(a));
const missingFromTs = [...sqlAliases].filter((a) => !tsAliases.has(a));

check(
  `every TS alias is in te_is_gta() SQL`,
  missingFromSql,
  []
);
check(
  `every te_is_gta() SQL alias is in TS`,
  missingFromTs,
  []
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
