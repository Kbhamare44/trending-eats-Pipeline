/**
 * Map viewport tuning.
 *
 * The thresholds here decide when the map shows individual pins and when it
 * shows cluster bubbles. They are deliberately in one place because getting
 * them wrong is very visible: too low and the whole GTA renders as hundreds
 * of native marker views, too high and a street-level view shows a bubble
 * reading "3" instead of three restaurants.
 */

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const MAP_CONFIG = {
  /**
   * At or above this zoom, return individual pins; below it, return clusters.
   *
   * Zoom 11 is roughly "one city fills the screen". Above that a viewport
   * holds few enough restaurants to draw individually; the whole GTA sits
   * around zoom 9 and must cluster.
   */
  pinZoomThreshold: num('MAP_PIN_ZOOM_THRESHOLD', 11),

  /**
   * Hard cap on pins returned for one viewport.
   *
   * react-native-maps gets sluggish past roughly 100 marker views on a mid
   * device. te_restaurants_in_bounds orders ranked-first, then by trend score,
   * then review count, so when a dense viewport exceeds this what survives
   * the cut is what is worth seeing rather than an arbitrary slice.
   */
  maxPins: num('MAP_MAX_PINS', 120),

  /**
   * Cluster grid size in degrees, by zoom band. Coarser when zoomed out, or
   * the "whole GTA" view returns a bubble per neighbourhood.
   */
  clusterGrid: {
    wide: num('MAP_CLUSTER_GRID_WIDE', 0.25),
    mid: num('MAP_CLUSTER_GRID_MID', 0.1),
    near: num('MAP_CLUSTER_GRID_NEAR', 0.04),
  },
} as const;

/** Grid size for a zoom level, coarse when far out. */
export function clusterGridForZoom(zoom: number): number {
  if (zoom < 8) return MAP_CONFIG.clusterGrid.wide;
  if (zoom < 10) return MAP_CONFIG.clusterGrid.mid;
  return MAP_CONFIG.clusterGrid.near;
}

export interface Bounds {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

/**
 * Validate and normalise a viewport from query params.
 *
 * Returns null when the rectangle is unusable. Swapped corners are repaired
 * rather than rejected — a client that sends maxLat below minLat gets the
 * region it meant, not an error — but a degenerate or non-finite rectangle is
 * refused, because `BETWEEN` on it would scan without matching anything and
 * look like "no restaurants here".
 */
export function parseBounds(params: URLSearchParams): Bounds | null {
  const read = (key: string) => {
    const raw = params.get(key);
    if (raw === null) return null;
    // Number('') and Number('   ') are both 0, not NaN. Without this check a
    // request with `minLat=` parses as latitude 0 — a viewport reaching the
    // equator — and the query scans a rectangle spanning half the planet
    // instead of failing loudly.
    if (raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };

  const minLat = read('minLat');
  const minLng = read('minLng');
  const maxLat = read('maxLat');
  const maxLng = read('maxLng');

  if (minLat === null || minLng === null || maxLat === null || maxLng === null) {
    return null;
  }

  // Latitudes outside [-90, 90] mean the client computed its region wrong;
  // clamp rather than refuse, since a map near a pole still has a valid view.
  const loLat = Math.max(-90, Math.min(minLat, maxLat));
  const hiLat = Math.min(90, Math.max(minLat, maxLat));
  const loLng = Math.max(-180, Math.min(minLng, maxLng));
  const hiLng = Math.min(180, Math.max(minLng, maxLng));

  if (loLat === hiLat || loLng === hiLng) return null;

  return { minLat: loLat, minLng: loLng, maxLat: hiLat, maxLng: hiLng };
}
