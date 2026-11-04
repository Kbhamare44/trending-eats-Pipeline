/**
 * Does the transcript actually improve extraction over the caption alone?
 *
 * This is the question that decides whether Supadata is worth a credit per
 * submission. It is NOT part of `npm run check` — it spends Gemini and
 * Supadata calls.
 *
 *   npx tsx scripts/measure-transcript.ts links.txt
 *   npx tsx scripts/measure-transcript.ts links.txt --limit 10
 *
 * One line per URL: what caption-only extraction found, what
 * caption-plus-transcript found, and whether the transcript changed anything
 * that matters — the restaurant name, the dish list, or the sponsorship call.
 *
 * ── THE PROMPT IN HERE IS A PROPOSAL, NOT SHIPPED ──
 *
 * COMBINED_SUFFIX below is the exact change I want to make to
 * lib/gemini/extract.ts. It lives in this script so it can be read and
 * measured before it goes anywhere near the pipeline. lib/gemini/extract.ts
 * is untouched; the live pipeline still extracts from the caption only.
 */

import { readFileSync } from 'node:fs';
import { fetchTikTokData, isSubmittableTikTokUrl } from '../lib/pipeline/tiktok';
import { fetchTranscript } from '../lib/pipeline/transcript';
import { extractRestaurantData } from '../lib/gemini/extract';
import { generateJSON, MODELS } from '../lib/gemini/client';
import { dedupeAndCount } from '../lib/dishes/normalize';
import type { ExtractionResult } from '../lib/types';

/**
 * PROPOSED addition to the extraction prompt. Two design points:
 *
 * 1. The transcript is labelled as spoken words and marked lower-trust than
 *    the caption for the restaurant NAME. Speech-to-text mangles proper
 *    nouns — "Bartholomew" is far more likely to survive typed than spoken —
 *    so letting the transcript override a caption name would make naming
 *    worse, not better.
 * 2. It is marked HIGHER value for dishes, which is the actual reason to want
 *    it: captions say "best bakery in Vaughan", the creator says "the
 *    pistachio croissant and the focaccia sandwich".
 *
 * It also repeats the existing anti-fabrication instruction, because a long
 * transcript gives a model much more raw material to over-interpret.
 */
const COMBINED_SUFFIX = `

You may be given a TRANSCRIPT of the creator speaking in the video, in
addition to the caption.

How to weigh the two:
- The RESTAURANT NAME is more reliable in the caption. A transcript is
  speech-to-text and mangles proper nouns. Only take a name from the
  transcript if the caption does not give one, and prefer a spelling that
  appears in the caption whenever both mention it.
- DISH NAMES are usually more reliable in the transcript, because people say
  what they ordered out loud and the caption rarely lists it. Prefer specific
  dishes the creator names.
- Sponsorship disclosure is usually in the caption, but a spoken "thanks to
  X for having me" counts too.

Use only what the caption and transcript actually contain. Do not infer
details about a real business from general knowledge, and do not state a
criticism neither source supports.`;

interface Variant {
  label: string;
  result: ExtractionResult | null;
  error?: string;
}

async function extractCombined(
  caption: string,
  creatorUsername: string,
  transcript: string
): Promise<ExtractionResult> {
  // Mirrors extractRestaurantData's message, plus the transcript block.
  const userMessage = `Caption: "${caption}"
Creator: @${creatorUsername}
Transcript: "${transcript}"

Extract restaurant information and return JSON in exactly this format:
{
  "restaurantName": "exact restaurant name or null if not mentioned",
  "city": "city name or null",
  "cuisine": "cuisine type (Italian, Japanese, etc.) or null",
  "dishesMentioned": ["array", "of", "specific", "dishes"],
  "sentiment": "positive" | "neutral" | "negative",
  "sentimentScore": number from -1.0 (very negative) to 1.0 (very positive),
  "pros": ["array of positive things mentioned"],
  "cons": ["array of negative things mentioned"],
  "atmosphere": "description of vibe/atmosphere or null",
  "priceRange": "$" | "$$" | "$$$" | "$$$$" | null,
  "goodFor": ["date night", "family", "brunch", "groups", "solo", "quick lunch"],
  "reviewerSummary": "one sentence summary of the reviewer's overall take",
  "isSponsored": boolean,
  "sponsorshipConfidence": number from 0 to 1,
  "sponsorshipSignals": ["list any specific signals found, empty array if none"]
}`;

  const base = readFileSync('lib/gemini/extract.ts', 'utf8');
  const match = base.match(/const EXTRACTION_PROMPT = `([\s\S]*?)`;/);
  if (!match) throw new Error('Could not read the shipped extraction prompt');

  const result = await generateJSON<any>({
    model: MODELS.extract,
    systemInstruction: match[1] + COMBINED_SUFFIX,
    userMessage,
    temperature: 0.1,
    maxOutputTokens: 32768,
  });

  return {
    restaurantName: result.restaurantName || null,
    city: result.city || null,
    cuisine: result.cuisine || null,
    dishesMentioned: result.dishesMentioned || [],
    sentiment: result.sentiment || 'neutral',
    sentimentScore: result.sentimentScore ?? 0,
    pros: result.pros || [],
    cons: result.cons || [],
    atmosphere: result.atmosphere || null,
    priceRange: result.priceRange || null,
    goodFor: result.goodFor || [],
    reviewerSummary: result.reviewerSummary || '',
    isSponsored: result.isSponsored || false,
    sponsorshipConfidence: result.sponsorshipConfidence ?? 0,
    sponsorshipSignals: result.sponsorshipSignals || [],
  } as ExtractionResult;
}

function dishSet(result: ExtractionResult | null): Set<string> {
  if (!result) return new Set();
  return new Set(dedupeAndCount(result.dishesMentioned).map((d) => d.item));
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const limitArg = args.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;

  if (!file) {
    console.error('usage: tsx scripts/measure-transcript.ts <links.txt> [--limit N]');
    process.exit(1);
  }

  const urls = readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .filter(isSubmittableTikTokUrl)
    .slice(0, limit);

  if (urls.length === 0) {
    console.error('No submittable TikTok URLs in that file.');
    process.exit(1);
  }

  console.log(`Measuring ${urls.length} video(s).\n`);

  let withTranscript = 0;
  let nameRecovered = 0;
  let nameChanged = 0;
  let dishesGained = 0;
  let dishesLost = 0;
  let sponsorshipChanged = 0;
  let totalExtraDishes = 0;

  for (const url of urls) {
    let caption = '';
    let creator = '';
    try {
      const tk = await fetchTikTokData(url);
      caption = tk.caption;
      creator = tk.creatorUsername;
    } catch (err: any) {
      console.log(`SKIP  ${url}\n      oEmbed failed: ${err.message}\n`);
      continue;
    }

    const transcript = await fetchTranscript(url, { captionLength: caption.length });

    const captionOnly: Variant = { label: 'caption', result: null };
    try {
      captionOnly.result = await extractRestaurantData(caption, creator);
    } catch (err: any) {
      captionOnly.error = err.message;
    }

    console.log(url);
    console.log(`  caption    ${caption.length} chars`);
    console.log(
      `  transcript ${transcript.status}` +
        (transcript.text ? ` ${transcript.text.length} chars` : '') +
        (transcript.detail ? ` (${transcript.detail})` : '')
    );

    if (transcript.status !== 'ok' || !transcript.text) {
      console.log(`  -> caption only. dishes: ${[...dishSet(captionOnly.result)].join(', ') || 'none'}\n`);
      continue;
    }

    withTranscript++;
    const combined: Variant = { label: 'caption+transcript', result: null };
    try {
      combined.result = await extractCombined(caption, creator, transcript.text);
    } catch (err: any) {
      combined.error = err.message;
    }

    const a = dishSet(captionOnly.result);
    const b = dishSet(combined.result);
    const gained = [...b].filter((d) => !a.has(d));
    const lost = [...a].filter((d) => !b.has(d));

    if (gained.length) { dishesGained++; totalExtraDishes += gained.length; }
    if (lost.length) dishesLost++;

    const nameA = captionOnly.result?.restaurantName ?? null;
    const nameB = combined.result?.restaurantName ?? null;
    if (!nameA && nameB) nameRecovered++;
    else if (nameA && nameB && nameA !== nameB) nameChanged++;

    if (
      captionOnly.result &&
      combined.result &&
      captionOnly.result.isSponsored !== combined.result.isSponsored
    ) {
      sponsorshipChanged++;
    }

    console.log(`  name       ${nameA ?? 'null'}  ->  ${nameB ?? 'null'}`);
    console.log(`  dishes     ${[...a].join(', ') || 'none'}`);
    console.log(`             -> ${[...b].join(', ') || 'none'}`);
    if (gained.length) console.log(`  GAINED     ${gained.join(', ')}`);
    if (lost.length) console.log(`  LOST       ${lost.join(', ')}`);
    console.log();
  }

  console.log('─'.repeat(64));
  console.log(`videos with a usable transcript   ${withTranscript}/${urls.length}`);
  console.log(`restaurant name recovered         ${nameRecovered}`);
  console.log(`restaurant name CHANGED           ${nameChanged}  <- check these by hand`);
  console.log(`videos that gained dishes         ${dishesGained}`);
  console.log(`extra dishes found in total       ${totalExtraDishes}`);
  console.log(`videos that LOST dishes           ${dishesLost}  <- a regression if non-zero`);
  console.log(`sponsorship verdict flipped       ${sponsorshipChanged}`);
  console.log();
  console.log('Worth the credit if dishes gained is high and name CHANGED is ~0.');
  console.log('If dishes gained is near zero, transcripts are not paying for themselves.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
