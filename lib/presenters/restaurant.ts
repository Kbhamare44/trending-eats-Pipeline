/**
 * API presentation shapes.
 *
 * The client must never have to infer meaning from a null. Every score that
 * can be absent is paired with an explicit `state` and a `label` the app can
 * render verbatim, so "we have no data" cannot be mistaken for "the score is
 * zero" — which is exactly the bug that put authenticity_score = 0 on
 * restaurants with no reviews at all.
 */

import { TrendState, ExperienceState, HypeVsReality } from '@/lib/config/trends';

export interface ScoreBlock {
  score: number | null;
  state: TrendState;
  confidence: number | null;
  observations: number;
  /** Ready-to-render label. Never implies more certainty than we have. */
  label: string;
  explanation: string | null;
}

export interface ExperienceBlock {
  score: number | null;
  state: ExperienceState;
  confidence: number | null;
  observations: number;
  label: string;
  explanation: string | null;
  sources: Array<{ source: string; label: string; value: number }>;
}

export interface HypeBlock {
  hypeScore: number | null;
  verdict: HypeVsReality;
  gap: number | null;
  summary: string;
  label: string;
}

export interface PresentedRestaurant {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  region: string | null;
  isGta: boolean;
  latitude: number | null;
  longitude: number | null;
  cuisineType: string | null;
  priceLevel: number | null;
  phone: string | null;
  website: string | null;
  aiSummary: string | null;
  reviewCount: number;
  savesCount: number;
  trend: ScoreBlock;
  experience: ExperienceBlock;
  hype: HypeBlock;
  topDishes: Array<{ slug?: string; name: string; mentions: number }>;
  /** Required attribution for any Google-sourced field we display. */
  attribution: string[];
  googleRating: number | null;
  googleRatingCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

const TREND_LABELS: Record<TrendState, string> = {
  ranked: 'Trending',
  warming_up: 'Gaining attention',
  insufficient_data: 'Not enough data yet',
};

const EXPERIENCE_LABELS: Record<ExperienceState, string> = {
  measured: 'Based on customer reports',
  insufficient_data: 'No reports yet',
};

const HYPE_LABELS: Record<HypeVsReality, string> = {
  lives_up: 'Lives up to the hype',
  mixed: 'Mixed reports',
  below_expectations: 'More hype than reviews support',
  insufficient_data: 'Not enough data to compare',
};

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readTrendState(value: unknown): TrendState {
  return value === 'ranked' || value === 'warming_up' ? value : 'insufficient_data';
}

function readExperienceState(value: unknown): ExperienceState {
  return value === 'measured' ? 'measured' : 'insufficient_data';
}

function readVerdict(value: unknown): HypeVsReality {
  return value === 'lives_up' ||
    value === 'mixed' ||
    value === 'below_expectations'
    ? value
    : 'insufficient_data';
}

/** Build the attribution lines that must accompany displayed Google data. */
function buildAttribution(row: any): string[] {
  const lines: string[] = [];
  if (row.google_rating !== null && row.google_rating !== undefined) {
    lines.push('Ratings and place details from Google');
  }
  return lines;
}

export function presentRestaurant(row: any): PresentedRestaurant {
  const trendState = readTrendState(row.trend_state);
  const experienceState = readExperienceState(row.experience_state);
  const verdict = readVerdict(row.hype_vs_reality);

  const components = row.trend_components ?? {};
  const experienceInputs = row.experience_inputs ?? {};
  const comparison = experienceInputs.comparison ?? {};

  // top_dishes may be the legacy JSON blob or the joined restaurant_dishes rows.
  const joined = Array.isArray(row.restaurant_dishes) ? row.restaurant_dishes : null;
  const topDishes = joined
    ? joined
        .filter((rd: any) => rd?.dishes)
        .sort((a: any, b: any) => (b.mention_count ?? 0) - (a.mention_count ?? 0))
        .slice(0, 8)
        .map((rd: any) => ({
          slug: rd.dishes.slug,
          name: rd.dishes.name,
          mentions: rd.mention_count ?? 0,
        }))
    : (Array.isArray(row.top_dishes) ? row.top_dishes : []).map((d: any) =>
        typeof d === 'string'
          ? { name: d, mentions: 0 }
          : { name: d?.dish ?? d?.name ?? 'Unknown', mentions: d?.mentions ?? 0 }
      );

  return {
    id: row.id,
    name: row.name,
    address: row.address ?? null,
    city: row.city ?? null,
    region: row.region ?? null,
    isGta: Boolean(row.is_gta),
    latitude: numberOrNull(row.latitude),
    longitude: numberOrNull(row.longitude),
    cuisineType: row.cuisine_type ?? null,
    priceLevel: numberOrNull(row.price_level),
    phone: row.phone ?? null,
    website: row.website ?? null,
    aiSummary: row.ai_summary ?? null,
    reviewCount: row.review_count ?? 0,
    savesCount: row.saves_count ?? 0,

    trend: {
      score: trendState === 'ranked' ? numberOrNull(row.trend_score) : null,
      state: trendState,
      confidence: numberOrNull(row.trend_confidence),
      observations: row.trend_observations ?? 0,
      label: TREND_LABELS[trendState],
      explanation: components.explanation ?? null,
    },

    experience: {
      score:
        experienceState === 'measured'
          ? numberOrNull(row.experience_score)
          : null,
      state: experienceState,
      confidence: numberOrNull(row.experience_confidence),
      observations: row.experience_observations ?? 0,
      label: EXPERIENCE_LABELS[experienceState],
      explanation: experienceInputs.explanation ?? null,
      sources: Array.isArray(experienceInputs.inputs)
        ? experienceInputs.inputs.map((i: any) => ({
            source: i.source,
            label: i.label,
            value: i.value,
          }))
        : [],
    },

    hype: {
      hypeScore: numberOrNull(row.hype_score),
      verdict,
      gap: numberOrNull(comparison.gap),
      summary:
        comparison.summary ??
        'We track popularity and customer experience separately.',
      label: HYPE_LABELS[verdict],
    },

    topDishes,
    attribution: buildAttribution(row),
    googleRating: numberOrNull(row.google_rating),
    googleRatingCount: numberOrNull(row.google_rating_count),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

export interface PresentedDish {
  id: string;
  slug: string;
  name: string;
  family: string | null;
  category: string | null;
  restaurantCount: number;
  mentionCount: number;
  trend: ScoreBlock;
}

export function presentDish(row: any): PresentedDish {
  const trendState = readTrendState(row.trend_state);
  const components = row.trend_components ?? {};

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    family: row.family ?? null,
    category: row.category ?? null,
    restaurantCount: row.restaurant_count ?? 0,
    mentionCount: row.mention_count ?? 0,
    trend: {
      score: trendState === 'ranked' ? numberOrNull(row.trend_score) : null,
      state: trendState,
      confidence: numberOrNull(row.trend_confidence),
      observations: row.trend_observations ?? 0,
      label: TREND_LABELS[trendState],
      explanation: components.explanation ?? null,
    },
  };
}

/** Columns every restaurant endpoint needs. Keeps the selects in step. */
export const RESTAURANT_COLUMNS = `
  id, name, address, city, region, is_gta, latitude, longitude,
  cuisine_type, price_level, phone, website, ai_summary,
  review_count, saves_count, top_dishes,
  trend_score, trend_state, trend_confidence, trend_observations,
  trend_components, trend_computed_at, hype_score,
  experience_score, experience_state, experience_confidence,
  experience_observations, experience_inputs, hype_vs_reality,
  first_party_rating, first_party_rating_count,
  google_rating, google_rating_count,
  created_at, updated_at
`;
