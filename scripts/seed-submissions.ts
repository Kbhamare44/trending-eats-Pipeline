/**
 * Seed the GTA pilot from a list of TikTok links you collected by hand.
 *
 *   npx tsx scripts/seed-submissions.ts links.txt
 *   npx tsx scripts/seed-submissions.ts links.txt --url https://your-app.vercel.app
 *   npx tsx scripts/seed-submissions.ts links.txt --dry-run
 *
 * `links.txt` is one URL per line; blank lines and lines starting with # are
 * ignored.
 *
 * WHY THIS IS A FILE OF URLS AND NOT A SCRAPER:
 *
 * The trend engine cannot say anything meaningful about four restaurants and
 * zero users — that is a data problem, and the fix is more content. The
 * tempting fix is a script that searches TikTok for "toronto food" and queues
 * what it finds. That is exactly the autonomous collection the v2 strategy put
 * out of scope, so this script does not do it.
 *
 * Instead it replays links a person chose, through the same public /api/submit
 * endpoint a user hits. Everything downstream is identical to a real
 * submission: same classification, same Places verification, same rejections.
 * The only thing being automated is the typing.
 *
 * Find the links the ordinary way: browse TikTok yourself, copy the share
 * links for GTA restaurant videos, and paste them into the file.
 */

import { readFileSync } from 'node:fs';

const DEFAULT_URL = 'http://localhost:3000';
/** Be polite to the endpoint, and to Gemini/Places quotas. */
const DELAY_MS = 3000;

interface Outcome {
  url: string;
  status: 'accepted' | 'rejected' | 'error';
  detail: string;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const urlIndex = args.indexOf('--url');
  const baseUrl =
    urlIndex >= 0 && args[urlIndex + 1]
      ? args[urlIndex + 1]
      : process.env.PIPELINE_BASE_URL ?? DEFAULT_URL;

  return { file, baseUrl, dryRun: args.includes('--dry-run') };
}

function readLinks(file: string): string[] {
  const raw = readFileSync(file, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .filter((line) => {
      if (!/^https?:\/\/([\w-]+\.)*tiktok\.com\//i.test(line)) {
        console.log(`  skip (not a TikTok URL): ${line}`);
        return false;
      }
      return true;
    });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { file, baseUrl, dryRun } = parseArgs();

  if (!file) {
    console.error(
      'Usage: npx tsx scripts/seed-submissions.ts <links.txt> [--url <base>] [--dry-run]'
    );
    process.exit(1);
  }

  const links = readLinks(file);
  console.log(`\n${links.length} link(s) from ${file}`);
  console.log(`Target: ${baseUrl}${dryRun ? ' (dry run)' : ''}\n`);

  if (dryRun) {
    links.forEach((link, i) => console.log(`  ${i + 1}. ${link}`));
    console.log('\nDry run — nothing submitted.');
    return;
  }

  const outcomes: Outcome[] = [];

  for (const [index, url] of links.entries()) {
    const label = `[${index + 1}/${links.length}]`;
    process.stdout.write(`${label} ${url.slice(0, 60)}… `);

    try {
      const response = await fetch(`${baseUrl}/api/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tiktokUrl: url }),
      });

      const body: any = await response.json().catch(() => ({}));

      if (body.success) {
        const where = body.inCoverageArea === false ? ' [outside GTA]' : '';
        console.log(`OK — ${body.restaurantName ?? body.restaurantId}${where}`);
        outcomes.push({
          url,
          status: 'accepted',
          detail: body.restaurantName ?? body.restaurantId,
        });
      } else {
        const reason = body.rejectionReason ?? body.error ?? `HTTP ${response.status}`;
        console.log(`rejected — ${reason}`);
        outcomes.push({ url, status: 'rejected', detail: reason });
      }
    } catch (err: any) {
      console.log(`ERROR — ${err.message}`);
      outcomes.push({ url, status: 'error', detail: err.message });
    }

    if (index < links.length - 1) await sleep(DELAY_MS);
  }

  const accepted = outcomes.filter((o) => o.status === 'accepted');
  const rejected = outcomes.filter((o) => o.status === 'rejected');
  const errored = outcomes.filter((o) => o.status === 'error');

  console.log(`\n── Summary ──`);
  console.log(`  accepted: ${accepted.length}`);
  console.log(`  rejected: ${rejected.length}`);
  console.log(`  errored:  ${errored.length}`);

  if (rejected.length > 0) {
    console.log(`\nRejections (normal — not every video is a restaurant review):`);
    for (const r of rejected) console.log(`  - ${r.detail}`);
  }

  if (errored.length > 0) {
    console.log(`\nErrors (these are worth looking at):`);
    for (const e of errored) console.log(`  - ${e.url}\n    ${e.detail}`);
  }

  console.log(
    `\nNext: trigger a recompute so trends and dishes pick these up:\n` +
      `  npx tsx scripts/recompute.ts --url ${baseUrl}\n`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
