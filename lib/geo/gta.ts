/**
 * Greater Toronto Area geography.
 *
 * Initial market is Toronto + GTA, so the app needs to know which rows are in
 * market and how to group them. Mirrors the SQL functions te_is_gta() and
 * te_gta_region() in migration 004 — keep the two in step.
 */

export interface GtaCity {
  /** Canonical display name. */
  name: string;
  region: 'Toronto' | 'Peel' | 'York' | 'Durham' | 'Halton';
  /** Lowercase strings that should resolve to this city. */
  aliases: string[];
  /** Rough centre, for map framing. */
  center: { latitude: number; longitude: number };
}

export const GTA_CITIES: GtaCity[] = [
  {
    name: 'Toronto',
    region: 'Toronto',
    aliases: [
      'toronto', 'etobicoke', 'scarborough', 'north york', 'east york',
      'willowdale', 'downsview', 'weston', 'rexdale', 'agincourt',
      'don mills', 'york mills', 'old toronto',
    ],
    center: { latitude: 43.6532, longitude: -79.3832 },
  },
  {
    name: 'Mississauga',
    region: 'Peel',
    aliases: [
      'mississauga', 'malton', 'streetsville', 'port credit', 'clarkson',
      'meadowvale', 'cooksville',
    ],
    center: { latitude: 43.5890, longitude: -79.6441 },
  },
  {
    name: 'Brampton',
    region: 'Peel',
    aliases: ['brampton', 'bramalea'],
    center: { latitude: 43.7315, longitude: -79.7624 },
  },
  {
    name: 'Caledon',
    region: 'Peel',
    aliases: ['caledon', 'bolton'],
    center: { latitude: 43.8668, longitude: -79.8663 },
  },
  {
    name: 'Vaughan',
    region: 'York',
    aliases: ['vaughan', 'woodbridge', 'concord', 'maple', 'kleinburg', 'thornhill'],
    center: { latitude: 43.8361, longitude: -79.4983 },
  },
  {
    name: 'Markham',
    region: 'York',
    aliases: ['markham', 'unionville', 'milliken'],
    center: { latitude: 43.8561, longitude: -79.3370 },
  },
  {
    name: 'Richmond Hill',
    region: 'York',
    aliases: ['richmond hill'],
    center: { latitude: 43.8828, longitude: -79.4403 },
  },
  {
    name: 'Newmarket',
    region: 'York',
    aliases: ['newmarket'],
    center: { latitude: 44.0592, longitude: -79.4613 },
  },
  {
    name: 'Aurora',
    region: 'York',
    aliases: ['aurora'],
    center: { latitude: 44.0065, longitude: -79.4504 },
  },
  {
    name: 'Whitchurch-Stouffville',
    region: 'York',
    aliases: ['whitchurch', 'stouffville', 'whitchurch-stouffville'],
    center: { latitude: 43.9709, longitude: -79.2449 },
  },
  {
    name: 'Oakville',
    region: 'Halton',
    aliases: ['oakville', 'bronte'],
    center: { latitude: 43.4675, longitude: -79.6877 },
  },
  {
    name: 'Burlington',
    region: 'Halton',
    aliases: ['burlington'],
    center: { latitude: 43.3255, longitude: -79.7990 },
  },
  {
    name: 'Milton',
    region: 'Halton',
    aliases: ['milton'],
    center: { latitude: 43.5183, longitude: -79.8774 },
  },
  {
    name: 'Halton Hills',
    region: 'Halton',
    aliases: ['halton hills', 'georgetown', 'acton'],
    center: { latitude: 43.6300, longitude: -79.9300 },
  },
  {
    name: 'Oshawa',
    region: 'Durham',
    aliases: ['oshawa'],
    center: { latitude: 43.8971, longitude: -78.8658 },
  },
  {
    name: 'Whitby',
    region: 'Durham',
    aliases: ['whitby', 'brooklin'],
    center: { latitude: 43.8975, longitude: -78.9429 },
  },
  {
    name: 'Ajax',
    region: 'Durham',
    aliases: ['ajax'],
    center: { latitude: 43.8509, longitude: -79.0204 },
  },
  {
    name: 'Pickering',
    region: 'Durham',
    aliases: ['pickering'],
    center: { latitude: 43.8384, longitude: -79.0868 },
  },
  {
    name: 'Clarington',
    region: 'Durham',
    aliases: ['clarington', 'bowmanville', 'courtice', 'newcastle'],
    center: { latitude: 43.9350, longitude: -78.6900 },
  },
  {
    name: 'Uxbridge',
    region: 'Durham',
    aliases: ['uxbridge'],
    center: { latitude: 44.1092, longitude: -79.1218 },
  },
  {
    name: 'Georgina',
    region: 'York',
    aliases: ['georgina', 'keswick', 'sutton'],
    center: { latitude: 44.2167, longitude: -79.4500 },
  },
  {
    // King Township, named for its main settlement. NOT "King": the city name
    // is registered as an alias too, and a bare "king" matches "100 King St W,
    // Hamilton" — which is an hour outside the GTA.
    name: 'King City',
    region: 'York',
    aliases: ['king city', 'nobleton', 'schomberg'],
    center: { latitude: 43.9239, longitude: -79.5285 },
  },
  {
    name: 'East Gwillimbury',
    region: 'York',
    aliases: ['east gwillimbury', 'holland landing', 'mount albert'],
    center: { latitude: 44.1033, longitude: -79.4553 },
  },
  {
    name: 'Scugog',
    region: 'Durham',
    aliases: ['scugog', 'port perry'],
    center: { latitude: 44.1058, longitude: -78.9456 },
  },
  {
    name: 'Brock',
    region: 'Durham',
    aliases: ['brock', 'beaverton', 'cannington', 'sunderland'],
    center: { latitude: 44.3100, longitude: -79.0500 },
  },
];

/** Bounding box used to bias Google Places searches toward the GTA. */
export const GTA_BOUNDS = {
  southwest: { latitude: 43.25, longitude: -80.05 },
  northeast: { latitude: 44.30, longitude: -78.55 },
};

export const GTA_CENTER = { latitude: 43.7, longitude: -79.5 };

const ALIAS_INDEX: Map<string, GtaCity> = (() => {
  const map = new Map<string, GtaCity>();
  for (const city of GTA_CITIES) {
    map.set(city.name.toLowerCase(), city);
    for (const alias of city.aliases) map.set(alias, city);
  }
  return map;
})();

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Aliases sorted longest-first, each as a word-boundary regex.
 *
 * Word boundaries are essential, not cosmetic: a plain substring test matches
 * "milton" inside "Hamilton" and "brock" inside "Brockville", so Hamilton — an
 * hour outside the GTA — was classifying as in-market. Longest-first ordering
 * keeps "richmond hill" from losing to a shorter alias.
 */
const ALIAS_PATTERNS: Array<{ pattern: RegExp; city: GtaCity }> = [
  ...ALIAS_INDEX.keys(),
]
  .sort((a, b) => b.length - a.length)
  .map((alias) => ({
    pattern: new RegExp(`\\b${escapeRegex(alias)}\\b`, 'i'),
    city: ALIAS_INDEX.get(alias)!,
  }));

/**
 * Resolve any city/neighbourhood string, or a full address, to a canonical
 * GTA city. Returns null when the text is not in the GTA at all — Ottawa,
 * for example, which is already sitting in the restaurants table.
 */
export function resolveGtaCity(
  city?: string | null,
  address?: string | null
): GtaCity | null {
  const direct = city?.trim().toLowerCase();
  if (direct && ALIAS_INDEX.has(direct)) return ALIAS_INDEX.get(direct)!;

  const haystack = `${city ?? ''} ${address ?? ''}`;
  if (!haystack.trim()) return null;

  for (const { pattern, city: match } of ALIAS_PATTERNS) {
    if (pattern.test(haystack)) return match;
  }
  return null;
}

export function isGta(city?: string | null, address?: string | null): boolean {
  return resolveGtaCity(city, address) !== null;
}

export function gtaRegion(
  city?: string | null,
  address?: string | null
): string | null {
  return resolveGtaCity(city, address)?.region ?? null;
}

/** Distinct city names, for the app's filter UI. */
export function gtaCityNames(): string[] {
  return [...new Set(GTA_CITIES.map((c) => c.name))].sort();
}
