/**
 * Last-resort restaurant-name candidates from informal text.
 *
 * WHY: TikTok removed `title` from its oEmbed response between 2026-08 and
 * 2026-11 — every submission up to 08-23 has a caption, none since. So the
 * model often sees only a speech-to-text transcript, and captions, when a
 * future change brings them back, are fragments: hashtags, lowercase, no
 * verb. "the restaurant is called X" never appears.
 *
 * This is a FALLBACK, run only after the model finds nothing. It proposes
 * candidates; it does not decide. A candidate still has to survive Google
 * Places, and an ambiguous or unverifiable one becomes a question to the
 * person rather than a stored address.
 *
 * Deliberately small: no new dependency, no second model call, no search
 * loop. It looks for a distinctive word or two sitting next to a food term.
 */

/** Food words that commonly follow or precede a business name. */
const FOOD_TERMS = [
  'shawarma', 'kebab', 'kabob', 'pizza', 'pizzeria', 'bakery', 'patisserie',
  'cafe', 'café', 'coffee', 'grill', 'grille', 'bbq', 'sushi', 'ramen',
  'noodle', 'taco', 'taqueria', 'burger', 'chicken', 'bistro', 'kitchen',
  'diner', 'deli', 'eatery', 'restaurant', 'juice', 'dessert', 'creamery',
  'gelato', 'donut', 'doughnut', 'bagel', 'sandwich', 'wings', 'curry',
  'biryani', 'pho', 'dumpling', 'steakhouse', 'tavern', 'bar',
];

/**
 * Words that make a phrase a description, not a name.
 *
 * "best shawarma in Toronto" must never become a business. These are checked
 * on the words AROUND the food term, which is what separates "Yasmine
 * shawarma" from "best shawarma".
 */
const GENERIC = new Set([
  'best', 'top', 'good', 'great', 'amazing', 'insane', 'crazy', 'favourite',
  'favorite', 'ultimate', 'perfect', 'cheap', 'cheapest', 'halal', 'authentic',
  'real', 'viral', 'famous', 'new', 'first', 'last', 'my', 'the', 'a', 'an',
  'this', 'that', 'some', 'any', 'every', 'more', 'most', 'better', 'worst',
  'bad', 'free', 'big', 'biggest', 'huge', 'little', 'small', 'hidden', 'gem',
  'spot', 'place', 'food', 'eat', 'eating', 'trying', 'try', 'review',
  'in', 'at', 'on', 'of', 'for', 'to', 'from', 'with', 'and', 'or', 'but',
  'toronto', 'gta', 'ontario', 'canada', 'mississauga', 'brampton', 'vaughan',
  'markham', 'scarborough', 'etobicoke', 'ramadan', 'today', 'here', 'there',
]);

export interface NameCandidate {
  /** Our best guess at the business name. */
  name: string;
  /** The phrase it came from, kept so a person can see why we guessed. */
  sourcePhrase: string;
  /** 'caption' | 'transcript' */
  source: string;
  /** Higher is better; only used for ordering. */
  score: number;
}

function words(text: string): string[] {
  return text
    .replace(/[#@]/g, ' ')
    .replace(/[^\p{L}\p{N}'\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Split a run-together hashtag: yasmineshawarma -> yasmine shawarma. */
function splitHashtagRun(token: string): string | null {
  const lower = token.toLowerCase();
  for (const term of FOOD_TERMS) {
    if (lower.length > term.length && lower.endsWith(term)) {
      const head = lower.slice(0, -term.length);
      if (head.length >= 3 && !GENERIC.has(head)) return `${head} ${term}`;
    }
    if (lower.length > term.length && lower.startsWith(term)) {
      const tail = lower.slice(term.length);
      if (tail.length >= 3 && !GENERIC.has(tail)) return `${term} ${tail}`;
    }
  }
  return null;
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

/**
 * Propose business names found in informal text.
 *
 * Returns at most `limit`, best first, or an empty array when nothing in the
 * text is distinctive enough to be a name. An empty array means "no name
 * detected", which is a different answer from "name detected, location not
 * confirmed" — the caller must keep them apart.
 */
export function extractNameCandidates(
  text: string,
  source: string,
  limit = 3
): NameCandidate[] {
  if (!text || typeof text !== 'string') return [];

  const found = new Map<string, NameCandidate>();
  const raw = words(text);
  const lower = raw.map((w) => w.toLowerCase());

  const add = (name: string, phrase: string, score: number) => {
    const key = name.toLowerCase();
    const existing = found.get(key);
    if (!existing || existing.score < score) {
      found.set(key, { name: titleCase(name), sourcePhrase: phrase, source, score });
    }
  };

  for (let i = 0; i < lower.length; i++) {
    const term = lower[i];

    // A hashtag or compound that contains a food term: #yasmineshawarma.
    const split = splitHashtagRun(raw[i]);
    if (split) add(split, raw[i], 3);

    if (!FOOD_TERMS.includes(term)) continue;

    // The distinctive word immediately before the food term is the usual
    // shape of a name: "Yasmine shawarma", "Pizzaiolo pizza".
    const before = lower[i - 1];
    if (before && !GENERIC.has(before) && before.length >= 3) {
      const twoBefore = lower[i - 2];
      // Allow a two-word name when the word before THAT is also distinctive.
      if (twoBefore && !GENERIC.has(twoBefore) && twoBefore.length >= 3) {
        add(`${twoBefore} ${before} ${term}`, `${raw[i - 2]} ${raw[i - 1]} ${raw[i]}`, 4);
      }
      add(`${before} ${term}`, `${raw[i - 1]} ${raw[i]}`, 5);
    }

    // Or it follows: "Shawarma Royale".
    const after = lower[i + 1];
    if (after && !GENERIC.has(after) && after.length >= 3) {
      add(`${term} ${after}`, `${raw[i]} ${raw[i + 1]}`, 4);
    }
  }

  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
