/**
 * Fixture tests for informal restaurant-name extraction.
 *
 * Offline. The fixtures are the cases from the bug report plus the ones that
 * must NOT match — a generic phrase becoming a business is worse than
 * extracting nothing, because it sends us to Google with a confident wrong
 * query and we store an address for a restaurant that does not exist.
 */
import { extractNameCandidates } from '../lib/pipeline/nameCandidates';

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
  else {
    failed++;
    console.error(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  }
}
const names = (t: string, src = 'caption') =>
  extractNameCandidates(t, src).map((c) => c.name);
const top = (t: string) => names(t)[0] ?? null;

// ── The reported case ────────────────────────────────────
check('informal fragment', top('yasmine shawarma 🔥🔥 best plate in the city'), 'Yasmine Shawarma');
check('no verb, no sentence', top('yasmine shawarma plate'), 'Yasmine Shawarma');
check('mid-sentence', top('went to yasmine shawarma today'), 'Yasmine Shawarma');

// ── Hashtags and spacing ─────────────────────────────────
check('hashtag run-together', top('#yasmineshawarma #halal'), 'Yasmine Shawarma');
check('hashtag with the term first', top('#shawarmapalace is open late'), 'Shawarma Palace');
check('extra whitespace', top('  yasmine   shawarma  '), 'Yasmine Shawarma');
check('punctuation', top('yasmine shawarma!!! 10/10'), 'Yasmine Shawarma');
check('hyphen spacing', top('Yasmine-Shawarma 🔥'), 'Yasmine Shawarma');
check('hashtag underscore spacing', top('#Yasmine_Shawarma'), 'Yasmine Shawarma');
check('original punctuation is preserved', extractNameCandidates('#Yasmine_Shawarma','caption')[0]?.sourcePhrase, '#Yasmine_Shawarma');
check('mixed-language caption', top('جرّبنا Yasmine Shawarma 🔥'), 'Yasmine Shawarma');

// ── Generic phrases are NOT businesses ───────────────────
// This is the important half. A false name is worse than no name.
check('best shawarma in toronto', names('best shawarma in toronto'), []);
check('halal shawarma spot', names('the best halal shawarma in the gta'), []);
check('bare food word', names('shawarma'), []);
check('cheap pizza', names('cheapest pizza in scarborough'), []);
check('empty text', names(''), []);
check('no food term at all', names('this place was incredible honestly'), []);
check('descriptive meal phrase is not a name', names('ordered their shawarma plate and it was great'), []);
check('comparison venue is not the reviewed subject', names('this is better than Messi shawarma', 'transcript'), []);
check('caption subject survives a comparison', names('Yasmine Shawarma is better than Messi Shawarma'), ['Yasmine Shawarma']);
check('actual recovered caption yields the actual name', top('Trying the best shawarma in Mississauga? Yaseen shawarma Getting the shawarma plate. #torontoeats #torontofood #shawarma #mississauga #toronto'), 'Yaseen Shawarma');

// ── Transliteration / mixed case ─────────────────────────
check('transliterated name', top('zaytoun grill was unreal'), 'Zaytoun Grill');
check('uppercase', top('BARAKAT BAKERY is the move'), 'Barakat Bakery');

// ── Source is preserved ──────────────────────────────────
const fromTranscript = extractNameCandidates('we went to yasmine shawarma', 'transcript');
check('source recorded', fromTranscript[0]?.source, 'transcript');
check('original phrase kept', fromTranscript[0]?.sourcePhrase, 'yasmine shawarma');

// ── Caption has a name, transcript does not ──────────────
// The real failing video: the transcript only names OTHER restaurants as
// comparisons, so it must not yield the subject of the review.
const realTranscript =
  "4,000 Google reviews, 4.5 rated. It's rated one of the best trauma place " +
  "in the GTA. I'm only here for their plates. This is definitely better " +
  'than Messy Sharma. I would drive out the way for this plate.';
check(
  'a transcript naming only comparisons yields no subject',
  names(realTranscript, 'transcript'),
  []
);
// And a caption that does name it still wins when one exists.
check(
  'caption candidate survives an unhelpful transcript',
  top('yasmine shawarma plate 🔥'),
  'Yasmine Shawarma'
);

// ── Bounded ──────────────────────────────────────────────
check(
  'at most three candidates',
  extractNameCandidates('yasmine shawarma barakat bakery zaytoun grill pizza nova deli king', 'caption').length <= 3,
  true
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
