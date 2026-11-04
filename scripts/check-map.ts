/**
 * Offline checks for map viewport maths.
 *
 * parseBounds guards a SQL rectangle query. A bad rectangle does not error —
 * it silently matches nothing, which reaches the user as an empty map rather
 * than as a failure, so these cases are worth pinning down.
 */

import { parseBounds, clusterGridForZoom, MAP_CONFIG } from '../lib/config/map';

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${label}\n  expected ${e}\n  got      ${a}`);
  }
}

const q = (s: string) => new URLSearchParams(s);

// ── Happy path ───────────────────────────────────────────
check(
  'a normal Toronto viewport parses',
  parseBounds(q('minLat=43.6&minLng=-79.5&maxLat=43.8&maxLng=-79.2')),
  { minLat: 43.6, minLng: -79.5, maxLat: 43.8, maxLng: -79.2 }
);

// ── Swapped corners are repaired, not rejected ───────────
// react-native-maps gives a centre plus deltas; a client that subtracts in
// the wrong order sends an inverted rectangle. Rejecting it would show an
// empty map for a perfectly valid view.
check(
  'inverted latitudes are repaired',
  parseBounds(q('minLat=43.8&minLng=-79.5&maxLat=43.6&maxLng=-79.2')),
  { minLat: 43.6, minLng: -79.5, maxLat: 43.8, maxLng: -79.2 }
);
check(
  'inverted longitudes are repaired',
  parseBounds(q('minLat=43.6&minLng=-79.2&maxLat=43.8&maxLng=-79.5')),
  { minLat: 43.6, minLng: -79.5, maxLat: 43.8, maxLng: -79.2 }
);

// ── Refusals ─────────────────────────────────────────────
check('a missing bound is refused', parseBounds(q('minLat=43.6&minLng=-79.5&maxLat=43.8')), null);
check('no params is refused', parseBounds(q('')), null);
check(
  'non-numeric is refused',
  parseBounds(q('minLat=abc&minLng=-79.5&maxLat=43.8&maxLng=-79.2')),
  null
);
check(
  'NaN is refused',
  parseBounds(q('minLat=NaN&minLng=-79.5&maxLat=43.8&maxLng=-79.2')),
  null
);
// A zero-area rectangle is the dangerous case: it is numerically valid, so it
// reaches Postgres, matches nothing, and looks like "no restaurants here".
check(
  'a zero-height rectangle is refused',
  parseBounds(q('minLat=43.6&minLng=-79.5&maxLat=43.6&maxLng=-79.2')),
  null
);
check(
  'a zero-width rectangle is refused',
  parseBounds(q('minLat=43.6&minLng=-79.5&maxLat=43.8&maxLng=-79.5')),
  null
);
check(
  'an empty-string bound is refused',
  parseBounds(q('minLat=&minLng=-79.5&maxLat=43.8&maxLng=-79.2')),
  null
);

// ── Clamping ─────────────────────────────────────────────
const clamped = parseBounds(q('minLat=-200&minLng=-400&maxLat=200&maxLng=400'));
check('latitudes clamp to the globe', clamped && clamped.minLat === -90 && clamped.maxLat === 90, true);
check('longitudes clamp to the globe', clamped && clamped.minLng === -180 && clamped.maxLng === 180, true);

// ── Cluster grid ─────────────────────────────────────────
// Must be monotonic: zooming in never produces a coarser grid, or bubbles
// would merge as you approach them.
const grids = [6, 7, 8, 9, 10, 11, 14].map(clusterGridForZoom);
check(
  'grid never coarsens as zoom increases',
  grids.every((g, i) => i === 0 || g <= grids[i - 1]),
  true
);
check('whole-region zoom uses the widest grid', clusterGridForZoom(6), MAP_CONFIG.clusterGrid.wide);
check('city zoom uses the near grid', clusterGridForZoom(10), MAP_CONFIG.clusterGrid.near);
check('every grid size is positive', grids.every((g) => g > 0), true);

// ── Config invariants ────────────────────────────────────
check('maxPins is positive', MAP_CONFIG.maxPins > 0, true);
check('pin threshold is a sane zoom', MAP_CONFIG.pinZoomThreshold > 0 && MAP_CONFIG.pinZoomThreshold < 20, true);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
