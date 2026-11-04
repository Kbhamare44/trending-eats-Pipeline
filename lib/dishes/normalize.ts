/**
 * Dish name normalization.
 *
 * Gemini returns dish names as free text, so the same dish arrives in many
 * spellings. Your live data already shows the failure mode: restaurants.common_cons
 * holds "line longer than you'd expect" twice — once with a straight
 * apostrophe and once with a typographic one — counted as two separate items.
 *
 * Goal: collapse surface variations WITHOUT collapsing genuinely different
 * dishes. "Matcha Croissants" and "matcha croissant" must merge; "matcha
 * croissant" and "matcha latte" must not. So we normalize spelling and
 * grammatical number, but never drop a distinguishing noun.
 */

/** Unicode punctuation that shows up in AI output and breaks naive matching. */
const SMART_PUNCTUATION: Array<[RegExp, string]> = [
  [/[‘’‚‛′´`]/g, "'"], // ' ' ‚ ‛ ′ ´ `
  [/[“”„‟″]/g, '"'],        // " " „ ‟ ″
  [/[‐‑‒–—―]/g, '-'],  // ‐ ‑ ‒ – — ―
  [/[…]/g, '...'],                              // …
  [/[   ⁠]/g, ' '],              // non-breaking spaces
];

/**
 * Qualifiers that describe HOW a dish is made or marketed, not WHAT it is.
 * Safe to strip from the front: "their famous smash burger" -> "smash burger".
 */
const LEADING_FILLER = [
  'the', 'a', 'an', 'their', 'his', 'her', 'its', 'our', 'my',
  'famous', 'viral', 'signature', 'legendary', 'iconic', 'classic',
  'best', 'amazing', 'incredible', 'insane', 'crazy', 'bomb',
  'house made', 'housemade', 'house-made', 'homemade', 'home made',
  'fresh', 'freshly made', 'authentic', 'traditional', 'real',
  'must try', 'must-try', 'highly recommend', 'recommended',
];

/** Trailing noise: "smash burger here" -> "smash burger". */
const TRAILING_FILLER = [
  'here', 'there', 'obviously', 'though', 'honestly', 'fr', 'ngl',
  'omg', 'yum', 'yummy', 'tho',
];

/**
 * Dish families — coarse groupings so Viral Dishes can show both a specific
 * dish and the broader wave it belongs to. Ordered MOST SPECIFIC FIRST, since
 * the first match wins: 'korean fried chicken' must be tested before
 * 'fried chicken', which must be tested before 'chicken'.
 */
const DISH_FAMILIES: Array<{
  family: string;
  category: 'dessert' | 'savoury' | 'drink';
  patterns: RegExp[];
}> = [
  { family: 'korean-fried-chicken', category: 'savoury', patterns: [/\bkorean\b.*\bchicken\b/, /\bkfc\b.*\bkorean\b/, /\byangnyeom\b/, /\bdakgangjeong\b/] },
  { family: 'nashville-hot-chicken', category: 'savoury', patterns: [/\bnashville\b/, /\bhot chicken\b/] },
  { family: 'fried-chicken', category: 'savoury', patterns: [/\bfried chicken\b/, /\bchicken tenders?\b/, /\bchicken sandwich\b/, /\bkaraage\b/, /\bchicken wings?\b/, /\bwings?\b/] },
  { family: 'smash-burger', category: 'savoury', patterns: [/\bsmash ?burger\b/, /\bsmashed burger\b/] },
  { family: 'burger', category: 'savoury', patterns: [/\bburger\b/, /\bcheeseburger\b/, /\bpatty melt\b/] },
  { family: 'birria', category: 'savoury', patterns: [/\bbirria\b/, /\bquesabirria\b/] },
  { family: 'tacos', category: 'savoury', patterns: [/\btacos?\b/, /\bal pastor\b/] },
  { family: 'shawarma', category: 'savoury', patterns: [/\bshawarma\b/, /\bdonair\b/, /\bgyro\b/] },
  { family: 'ramen', category: 'savoury', patterns: [/\bramen\b/, /\btonkotsu\b/, /\btsukemen\b/] },
  { family: 'pho', category: 'savoury', patterns: [/\bpho\b/, /\bphở\b/] },
  { family: 'dumplings', category: 'savoury', patterns: [/\bdumplings?\b/, /\bgyoza\b/, /\bxiao long bao\b/, /\bsoup dumplings?\b/, /\bmomos?\b/] },
  { family: 'sushi', category: 'savoury', patterns: [/\bsushi\b/, /\bsashimi\b/, /\bomakase\b/, /\bnigiri\b/, /\bmaki\b/, /\bhand ?roll\b/] },
  { family: 'pizza', category: 'savoury', patterns: [/\bpizza\b/, /\bdetroit style\b/, /\bneapolitan\b/, /\bpepperoni\b/] },
  { family: 'pasta', category: 'savoury', patterns: [/\bpasta\b/, /\bcacio e pepe\b/, /\bcarbonara\b/, /\brigatoni\b/, /\bpappardelle\b/, /\blasagna\b/] },
  { family: 'biryani', category: 'savoury', patterns: [/\bbiryani\b/, /\bbiriyani\b/] },
  { family: 'butter-chicken', category: 'savoury', patterns: [/\bbutter chicken\b/, /\bmakhani\b/] },
  { family: 'poutine', category: 'savoury', patterns: [/\bpoutine\b/] },
  { family: 'sandwich', category: 'savoury', patterns: [/\bsandwich(es)?\b/, /\bsub\b/, /\bpanini\b/, /\bbanh mi\b/, /\bfocaccia\b/] },
  { family: 'bbq', category: 'savoury', patterns: [/\bbrisket\b/, /\bribs?\b/, /\bpulled pork\b/, /\bbarbecue\b/, /\bbbq\b/] },
  { family: 'steak', category: 'savoury', patterns: [/\bsteak\b/, /\btomahawk\b/, /\bribeye\b/, /\bwagyu\b/] },
  { family: 'breakfast', category: 'savoury', patterns: [/\bpancakes?\b/, /\bwaffles?\b/, /\bfrench toast\b/, /\bbenedict\b/, /\bomelette?\b/, /\bshakshuka\b/] },

  { family: 'matcha', category: 'drink', patterns: [/\bmatcha\b/] },
  { family: 'coffee', category: 'drink', patterns: [/\bcoffee\b/, /\blatte\b/, /\bespresso\b/, /\bcappuccino\b/, /\bcortado\b/, /\bflat white\b/, /\bcold brew\b/, /\bamericano\b/] },
  { family: 'bubble-tea', category: 'drink', patterns: [/\bbubble tea\b/, /\bboba\b/, /\bmilk tea\b/] },

  { family: 'croissant', category: 'dessert', patterns: [/\bcroissants?\b/, /\bcruffins?\b/, /\bkouign amann\b/] },
  { family: 'cookie', category: 'dessert', patterns: [/\bcookies?\b/] },
  { family: 'donut', category: 'dessert', patterns: [/\bdonuts?\b/, /\bdoughnuts?\b/] },
  { family: 'cake', category: 'dessert', patterns: [/\bcakes?\b/, /\bcheesecake\b/, /\bbasque\b/, /\btiramisu\b/] },
  { family: 'ice-cream', category: 'dessert', patterns: [/\bice ?cream\b/, /\bgelato\b/, /\bsoft serve\b/, /\bsundae\b/] },
  { family: 'pastry', category: 'dessert', patterns: [/\bpastr(y|ies)\b/, /\bdanish\b/, /\btart\b/, /\bbabka\b/, /\bscones?\b/, /\bmuffins?\b/, /\bbrioche\b/] },
  { family: 'bread', category: 'dessert', patterns: [/\bbreads?\b/, /\bsourdough\b/, /\bbagels?\b/, /\bbaguette\b/] },
  { family: 'crepe', category: 'dessert', patterns: [/\bcr[eê]pes?\b/] },
  { family: 'dessert', category: 'dessert', patterns: [/\bdessert\b/, /\bchocolate\b/, /\bbrownie\b/, /\bpudding\b/, /\bbaklava\b/, /\bkunafa\b/, /\bknafeh\b/] },
];

/**
 * Collapse simple English plurals. Conservative on purpose — over-eager
 * stemming turns distinct dishes into one.
 */
function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (/(ss|us|is|as)$/.test(word)) return word;            // bass, hummus, tzatziki-ish
  if (/ies$/.test(word)) return word.slice(0, -3) + 'y';   // pastries -> pastry
  if (/(ches|shes|xes|zes|ses)$/.test(word)) return word.slice(0, -2); // sandwiches -> sandwich
  if (/oes$/.test(word)) return word.slice(0, -2);         // potatoes -> potato
  if (/s$/.test(word)) return word.slice(0, -1);           // burgers -> burger
  return word;
}

/**
 * Normalize a raw dish string into a stable comparison key.
 * Returns an empty string for input that is not a dish name at all.
 */
export function normalizeDishName(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';

  let s = raw;
  for (const [pattern, replacement] of SMART_PUNCTUATION) {
    s = s.replace(pattern, replacement);
  }

  s = s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s'-]/g, ' ')   // keep intra-word ' and -
    .replace(/'/g, '')                // their's -> theirs, don't -> dont
    .replace(/\s*-\s*/g, ' ')         // "house-made" already handled, split rest
    .replace(/\s+/g, ' ')
    .trim();

  if (!s) return '';

  // Strip leading filler, repeatedly (longest phrase first).
  const leading = [...LEADING_FILLER].sort((a, b) => b.length - a.length);
  let changed = true;
  while (changed) {
    changed = false;
    for (const filler of leading) {
      if (s === filler) return '';
      if (s.startsWith(filler + ' ')) {
        s = s.slice(filler.length + 1).trim();
        changed = true;
        break;
      }
    }
  }

  // Strip trailing filler.
  changed = true;
  while (changed) {
    changed = false;
    for (const filler of TRAILING_FILLER) {
      if (s.endsWith(' ' + filler)) {
        s = s.slice(0, -(filler.length + 1)).trim();
        changed = true;
        break;
      }
    }
  }

  s = s.split(' ').map(singularize).join(' ').replace(/\s+/g, ' ').trim();

  // Reject things that are clearly not dish names.
  if (s.length < 2) return '';
  if (/^\d+$/.test(s)) return '';
  if (s.split(' ').length > 6) return '';  // a sentence, not a dish

  return s;
}

/** URL-safe slug from a normalized name. */
export function dishSlug(normalized: string): string {
  return normalized.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

/** Title Case for display: "matcha croissant" -> "Matcha Croissant". */
export function dishDisplayName(normalized: string): string {
  const alwaysLower = new Set(['and', 'with', 'in', 'on', 'of', 'a', 'the', 'al']);
  return normalized
    .split(' ')
    .map((word, i) =>
      i > 0 && alwaysLower.has(word)
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join(' ');
}

export interface DishClassification {
  normalized: string;
  slug: string;
  displayName: string;
  family: string | null;
  category: 'dessert' | 'savoury' | 'drink' | null;
}

/** Full classification of one raw dish string. Returns null if unusable. */
export function classifyDish(raw: string): DishClassification | null {
  const normalized = normalizeDishName(raw);
  if (!normalized) return null;

  let family: string | null = null;
  let category: 'dessert' | 'savoury' | 'drink' | null = null;

  for (const candidate of DISH_FAMILIES) {
    if (candidate.patterns.some((p) => p.test(normalized))) {
      family = candidate.family;
      category = candidate.category;
      break;
    }
  }

  return {
    normalized,
    slug: dishSlug(normalized),
    displayName: dishDisplayName(normalized),
    family,
    category,
  };
}

/**
 * Deduplicate and count a list of free-text strings using the same
 * normalization. This is what fixes the duplicated common_pros/common_cons:
 * variants merge, and the label shown is the most frequent original spelling.
 */
export function dedupeAndCount(
  items: string[]
): Array<{ item: string; count: number }> {
  const groups = new Map<string, { count: number; spellings: Map<string, number> }>();

  for (const raw of items) {
    if (!raw || typeof raw !== 'string') continue;
    const key = normalizeDishName(raw) || raw.trim().toLowerCase();
    if (!key) continue;

    const group = groups.get(key) ?? { count: 0, spellings: new Map() };
    group.count += 1;
    const cleaned = raw.trim();
    group.spellings.set(cleaned, (group.spellings.get(cleaned) ?? 0) + 1);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([, group]) => {
      const best = [...group.spellings.entries()].sort((a, b) => b[1] - a[1])[0];
      return { item: best[0], count: group.count };
    })
    .sort((a, b) => b.count - a.count);
}
