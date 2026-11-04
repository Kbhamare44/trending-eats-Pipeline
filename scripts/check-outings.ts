/**
 * Offline checks for outing pairing maths.
 *
 * The thing worth guarding here is COST. The Routes API bills per element, so
 * the invariant that matters is that ranking never touches it — if a future
 * change ranks candidates through Routes, spend grows quadratically with the
 * candidate set and nothing in the response would look different.
 */

import { haversineMetres, estimateWalkMinutes } from '../lib/geo/distance';
import { OUTING_CONFIG } from '../lib/config/outings';
import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  }
}

function near(label: string, actual: number, expected: number, tolerance: number) {
  if (Math.abs(actual - expected) <= tolerance) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${label}\n  expected ~${expected} (±${tolerance})\n  got      ${actual}`);
  }
}

// ── Distance ─────────────────────────────────────────────
const unionStation = { latitude: 43.6453, longitude: -79.3806 };
const cnTower = { latitude: 43.6426, longitude: -79.3871 };
const yorkdale = { latitude: 43.7254, longitude: -79.4522 };

// Union Station to the CN Tower is about 600m on the ground.
near('Union to CN Tower', haversineMetres(unionStation, cnTower), 600, 120);
// Union to Yorkdale is about 11km.
near('Union to Yorkdale', haversineMetres(unionStation, yorkdale) / 1000, 11, 1.5);
check('a point is zero from itself', haversineMetres(unionStation, unionStation), 0);
check('distance is symmetric',
  Math.round(haversineMetres(unionStation, cnTower)),
  Math.round(haversineMetres(cnTower, unionStation)));

// ── Walking estimate ─────────────────────────────────────
check('zero distance is zero minutes', estimateWalkMinutes(0, 80), 0);
// Never report "0 minutes away" for two different places — it reads as a bug.
check('a very short walk is still a minute', estimateWalkMinutes(10, 80), 1);
check('800m at 80 m/min is 10 minutes', estimateWalkMinutes(800, 80), 10);
// The estimate is optimistic by construction: a real route is longer than the
// straight line, never shorter. Anything that made it pessimistic would mean
// the estimate and the measured value disagree in the wrong direction.
check(
  'the estimate is monotonic in distance',
  estimateWalkMinutes(400, 80) <= estimateWalkMinutes(800, 80),
  true
);

// ── Config invariants ────────────────────────────────────
check(
  'the straight-line cutoff is inside the search radius',
  OUTING_CONFIG.maxStraightLineM <= OUTING_CONFIG.searchRadiusM,
  true
);
check('at least one activity category', OUTING_CONFIG.categories.length >= 1, true);
check('walking speed is positive', OUTING_CONFIG.walkMetresPerMinute > 0, true);
check('pairings are capped', OUTING_CONFIG.maxPairings > 0 && OUTING_CONFIG.maxPairings <= 10, true);

// A radius that stops being walkable makes "then walk to" a false promise.
// 2km at a normal pace is 25 minutes, which is the outer edge of plausible.
check(
  'the search radius stays walkable',
  OUTING_CONFIG.searchRadiusM <= 2000,
  true
);

// ── THE COST INVARIANT ───────────────────────────────────
// Routes must be reachable from exactly one place, and that place must take a
// single origin and destination. A matrix call here would bill
// candidates x pairings elements for numbers only used to sort.
/**
 * Comments are stripped before these checks. The first version of this test
 * failed on routes.ts, because that file names computeRouteMatrix in a
 * comment explaining why it must not be used — the test was matching the
 * warning rather than a call.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const routesSource = stripComments(readFileSync('lib/google/routes.ts', 'utf8'));
check(
  'routes.ts does not call computeRouteMatrix',
  /computeRouteMatrix/.test(routesSource),
  false
);
check(
  'routes.ts asks only for duration and distance in its field mask',
  /X-Goog-FieldMask['"]?\s*:\s*['"]routes\.duration,routes\.distanceMeters['"]/.test(routesSource),
  true
);

const pairSource = stripComments(readFileSync('lib/outings/pair.ts', 'utf8'));
// Exactly one call site, and it must come after the filter+sort that chooses
// the pair.
const walkCalls = (pairSource.match(/await walkingLeg\(/g) ?? []).length;
check('walkingLeg is called from exactly one place', walkCalls, 1);
check(
  'ranking happens on haversine, not Routes',
  /haversineMetres\(/.test(pairSource),
  true
);
check(
  'the distance filter runs before the Routes call',
  pairSource.indexOf('maxStraightLineM') < pairSource.indexOf('await walkingLeg('),
  true
);

// ── "Could not ask" must not be reported as "nothing nearby" ─────────────
// The first version of buildPairings caught a denied Places key and told the
// user their city had nothing walkable in it. These assertions pin the
// distinction into the source so it cannot regress silently.
check(
  'pairing distinguishes a failed search from an empty one',
  /searchFailed/.test(pairSource),
  true
);
check(
  'a total search failure does not claim nothing is nearby',
  /could not reach the activity search/i.test(pairSource),
  true
);
check(
  "the provider's error is surfaced, not just logged",
  /searchError/.test(pairSource),
  true
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
