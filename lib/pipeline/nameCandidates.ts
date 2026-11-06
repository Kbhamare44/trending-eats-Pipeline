import { GTA_CITIES } from '@/lib/geo/gta';

/**
 * Last-resort restaurant-name candidates from informal text.
 *
 * Missing oEmbed metadata can leave only speech available. A caption may
 * still exist on TikTok or be retrieved by the supported metadata provider.
 * Both sources can contain fragments, hashtags and mixed-language names.
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
  'was', 'were', 'is', 'are', 'been', 'went', 'visited', 'tried', 'ordered',
  'getting', 'got', 'their', 'our', 'your', 'they', 'them', 'than', 'then',
  'plate', 'plates', 'meal', 'meals', 'delicious', 'unreal', 'honestly',
  'le', 'la', 'les', 'de', 'des', 'du', 'dans', 'meilleur', 'meilleure',
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

function words(text: string) {
  return [...text.matchAll(/[#@]?[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)]
    .map(match => ({ word: match[0].replace(/^[#@]/, ''), start: match.index!, end: match.index! + match[0].length }));
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

/** Evidence must occur in the source and describe the subject, not a rival. */
export function isSubjectPhrase(text: string, phrase: string): boolean {
  if (!phrase.trim()) return false;
  for (let start = text.indexOf(phrase); start >= 0; start = text.indexOf(phrase, start + 1)) {
    const context = text.slice(Math.max(0, start - 160), start + phrase.length).split(/[.!?\n]/).at(-1) ?? '';
    const comparison = [...context.matchAll(/\b(?:(?:better|worse|cheaper|more expensive)\s+than|compared\s+to|(?:up there|on par)\s+with|unlike|versus|vs)\b/giu)].at(-1);
    if (!comparison || /\b(?:went to|visited|reviewing|we are at|we're at|i am at|i'm at)\b/i.test(context.slice(comparison.index! + comparison[0].length))) return true;
  }
  return false;
}

/** Prefer prose clues over broad discovery hashtags; conflicting cities ask. */
export function cityClue(caption: string, transcript: string, proposed?: string | null, namePhrase?: string) {
  const source = `${caption}\n${transcript}`;
  const prose = (namePhrase ? source.replaceAll(namePhrase, '') : source).replace(/#[\p{L}\p{N}_]+/gu, ' ');
  const found = GTA_CITIES.filter(city => {
    const match = prose.match(new RegExp(`\\b${city.name}\\b`, 'i'));
    return match && isSubjectPhrase(prose, match[0]);
  });
  if (found.length > 1) return { city: '', conflict: true };
  if (found[0]) return { city: found[0].name, conflict: false };
  const hashtags = GTA_CITIES.filter(city => new RegExp(`#${city.name.replace(/[ -]/g, '')}\\b`, 'i').test(caption));
  if (hashtags.length > 1) return { city: '', conflict: true };
  if (hashtags[0]) return { city: hashtags[0].name, conflict: false };
  const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const literal = proposed?.trim();
  return { city: literal && !/^(?:gta|greater toronto area|ontario|canada|unknown)$/i.test(literal) && (` ${normalize(prose)} `).includes(` ${normalize(literal)} `) ? literal : '', conflict: false };
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
  const tokens = words(text);
  const raw = tokens.map(token => token.word);
  const lower = raw.map((w) => w.toLowerCase());

  const add = (name: string, start: number, end: number, score: number) => {
    const phrase = text.slice(tokens[start].start, tokens[end].end);
    if (!isSubjectPhrase(text, phrase)) return;
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
    if (split) add(split, i, i, 3);

    if (!FOOD_TERMS.includes(term)) continue;

    // The distinctive word immediately before the food term is the usual
    // shape of a name: "Yasmine shawarma", "Pizzaiolo pizza".
    const before = lower[i - 1];
    if (before && !GENERIC.has(before) && before.length >= 3) {
      const twoBefore = lower[i - 2];
      // Allow a two-word name when the word before THAT is also distinctive.
      if (twoBefore && !GENERIC.has(twoBefore) && twoBefore.length >= 3) {
        add(`${twoBefore} ${before} ${term}`, i - 2, i, 4);
      }
      add(`${before} ${term}`, i - 1, i, 5);
    }

    // Or it follows: "Shawarma Royale".
    const after = lower[i + 1];
    if (after && !GENERIC.has(after) && after.length >= 3) {
      add(`${term} ${after}`, i, i + 1, 4);
    }
  }

  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
