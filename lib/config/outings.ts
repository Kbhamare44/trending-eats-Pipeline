/**
 * Outing pairing config.
 *
 * ONE restaurant plus ONE nearby thing to do, with the walking time between
 * them. Deliberately not an optimizer: a multi-stop itinerary needs
 * constraint checking against opening hours and travel time, and there is no
 * point building that before anyone has said they want the simple version.
 *
 * ── THE COST SHAPE, WHICH DRIVES EVERY NUMBER HERE ──
 *
 * Places Nearby Search is priced per request. The Routes API is priced per
 * ELEMENT, so a naive "distance from every restaurant to every activity"
 * matrix is restaurants x activities requests' worth of billing — 5 stops is
 * 20 pairs, and it grows quadratically.
 *
 * So ranking uses straight-line distance, computed locally for free, and
 * Routes is called ONCE per returned pairing, for the pair already chosen.
 * `maxPairings` is therefore also the maximum number of Routes elements a
 * request can bill.
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

export const OUTING_CONFIG = {
  /**
   * How many pairings one request returns, and therefore the hard cap on
   * Routes elements billed per request. Three is enough to feel like a
   * choice without being a matrix.
   */
  maxPairings: num('OUTING_MAX_PAIRINGS', 3),

  /**
   * Metres around a restaurant to look for something to do.
   *
   * 1200m is roughly a 15 minute walk. Beyond that "and then walk to" stops
   * being a plan and the pairing should be driving, which is a different
   * product.
   */
  searchRadiusM: num('OUTING_SEARCH_RADIUS_M', 1200),

  /**
   * Discard a pairing further apart than this in a straight line.
   *
   * Checked BEFORE Routes is called, so a bad pairing costs nothing. Slightly
   * under the search radius because straight-line always understates walking
   * distance — buildings, rivers and one-way streets only ever make it
   * longer.
   */
  maxStraightLineM: num('OUTING_MAX_STRAIGHT_LINE_M', 1000),

  /** Activity types to search, in order of preference. */
  categories: (
    process.env.OUTING_CATEGORIES ??
    'movie_theater,park,museum,art_gallery,bowling_alley,tourist_attraction,amusement_park'
  )
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean),

  /**
   * Minimum Google rating for an activity to be suggested.
   *
   * Pairing a genuinely trending restaurant with a badly-reviewed bar makes
   * the whole suggestion look careless, and the thing people blame is the
   * app, not the bar.
   */
  minActivityRating: num('OUTING_MIN_ACTIVITY_RATING', 3.8),

  /** Evidence floor before a low rating can disqualify a destination. */
  minActivityRatingCount: num('OUTING_MIN_ACTIVITY_RATING_COUNT', 20),

  /**
   * Call the Routes API for the chosen pairings.
   *
   * Off means pairings still work and report straight-line distance with an
   * estimated walking time, clearly labelled as an estimate. Useful as a
   * cost kill-switch that degrades rather than breaks.
   */
  useRoutesApi: bool('OUTING_USE_ROUTES_API', true),

  /**
   * Average walking speed in metres per minute, for the estimate used when
   * Routes is unavailable. 80 m/min (4.8 km/h) is a normal unhurried pace.
   */
  walkMetresPerMinute: num('OUTING_WALK_M_PER_MIN', 80),

  /** How long a cached activity row may be reused before re-querying Places. */
  activityTtlHours: num('OUTING_ACTIVITY_TTL_HOURS', 24 * 14),
} as const;

if (OUTING_CONFIG.maxStraightLineM > OUTING_CONFIG.searchRadiusM) {
  throw new Error(
    'OUTING_MAX_STRAIGHT_LINE_M above OUTING_SEARCH_RADIUS_M would discard nothing'
  );
}
