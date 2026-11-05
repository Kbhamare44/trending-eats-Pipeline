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
 * Compares the shipped extractor with and without the spoken transcript.
 * Combined source handling now lives in lib/gemini/extract.ts.
 */

import { readFileSync } from 'node:fs';
import { fetchTikTokData, isSubmittableTikTokUrl, extractVideoId } from '../lib/pipeline/tiktok';
import { fetchTranscript } from '../lib/pipeline/transcript';
import { extractRestaurantData } from '../lib/gemini/extract';
import { dedupeAndCount } from '../lib/dishes/normalize';
import type { ExtractionResult } from '../lib/types';

interface Variant {
  label: string;
  result: ExtractionResult | null;
  error?: string;
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

    const transcript = await fetchTranscript(url, { videoId: extractVideoId(url), captionLength: caption.length });

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
      combined.result = await extractRestaurantData(caption, creator, undefined, transcript.text);
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
