/**
 * Offline checks for the submission queue's pure logic.
 *
 * No network, no database. What is covered here is the part that decides
 * whether a link is accepted at all and whether it is a duplicate — get
 * either wrong and you either reject real submissions or pay for the whole
 * Gemini + Places pipeline twice for the same video.
 */

import {
  canonicalTikTokUrl, extractVideoId,
  isSubmittableTikTokUrl,
} from '../lib/pipeline/tiktok';
import { QUEUE_CONFIG, isTerminalStatus } from '../lib/config/pipeline';
import { inMemoryLimit, clientKey, LIMITS } from '../lib/http/ratelimit';

let passed = 0;
let failed = 0;

async function run() {

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${label}\n  expected ${e}\n  got      ${a}`);
  }
}

// ── URLs we must accept ──────────────────────────────────
check(
  'standard video URL is submittable',
  isSubmittableTikTokUrl('https://www.tiktok.com/@someone/video/7234567890123456789'),
  true
);
check(
  'short vt link is submittable',
  isSubmittableTikTokUrl('https://vt.tiktok.com/ZSAbCdEf/'),
  true
);
check(
  'bare tiktok.com host is submittable',
  isSubmittableTikTokUrl('https://tiktok.com/@a/video/123'),
  true
);

// ── URLs we must reject ──────────────────────────────────
// Each of these passes a naive `url.includes('tiktok.com')` test.
check(
  'suffixed lookalike host is rejected',
  isSubmittableTikTokUrl('https://tiktok.com.evil.test/@a/video/123'),
  false
);
check(
  'prefixed lookalike host is rejected',
  isSubmittableTikTokUrl('https://nottiktok.com/@a/video/123'),
  false
);
check(
  'tiktok.com in the path is rejected',
  isSubmittableTikTokUrl('https://evil.test/tiktok.com/video/123'),
  false
);
check('http is rejected', isSubmittableTikTokUrl('http://www.tiktok.com/@a/video/1'), false);
check('garbage is rejected', isSubmittableTikTokUrl('not a url'), false);
check('empty is rejected', isSubmittableTikTokUrl(''), false);

// ── Video id extraction, which drives dedupe ─────────────
check(
  'id from a canonical URL',
  extractVideoId('https://www.tiktok.com/@chef/video/7234567890123456789'),
  '7234567890123456789'
);
check(
  'id survives query parameters',
  extractVideoId('https://www.tiktok.com/@chef/video/7234567890123456789?is_from_webapp=1&sender_device=pc'),
  '7234567890123456789'
);
check(
  'id from a username containing dots',
  extractVideoId('https://www.tiktok.com/@the.food.guy/video/7111111111111111111'),
  '7111111111111111111'
);
check(
  'short link yields its code, not a video id',
  extractVideoId('https://vt.tiktok.com/ZSAbCdEf/'),
  'ZSAbCdEf'
);
check(
  'a profile URL has no video id',
  extractVideoId('https://www.tiktok.com/@chef'),
  null
);

// Two spellings of the SAME video must produce the same dedupe key, or the
// same video gets processed twice and the restaurant gets a phantom second
// review — which inflates its submission-growth trend component.
const plain = extractVideoId('https://www.tiktok.com/@chef/video/7234567890123456789');
const tracked = extractVideoId(
  'https://www.tiktok.com/@chef/video/7234567890123456789?is_from_webapp=1'
);
check('tracking params do not break dedupe', plain === tracked && plain !== null, true);

check('tracked video URLs share one queue URL', canonicalTikTokUrl('https://m.tiktok.com/@chef/video/7234567890123456789?share=1#fragment'), 'https://www.tiktok.com/@chef/video/7234567890123456789');

// ── Lifecycle ────────────────────────────────────────────
check('completed is terminal', isTerminalStatus('completed'), true);
check('rejected is terminal', isTerminalStatus('rejected'), true);
check('failed is terminal', isTerminalStatus('failed'), true);
check('pending is not terminal', isTerminalStatus('pending'), false);
check('processing is not terminal', isTerminalStatus('processing'), false);

// ── Config invariants ────────────────────────────────────
check('maxAttempts is at least 1', QUEUE_CONFIG.maxAttempts >= 1, true);
check('batchSize is positive', QUEUE_CONFIG.batchSize > 0, true);
check('stuck threshold is positive', QUEUE_CONFIG.stuckAfterMinutes > 0, true);

// ── Rate limiting ────────────────────────────────────────
// The limiter guards endpoints that cost money per call, so the boundary
// behaviour matters: an off-by-one here either blocks real people or lets a
// loop through.
const WINDOW = 60_000;
const key = `test:${Math.random()}`;
let lastAllowed = true;
for (let i = 1; i <= 3; i++) {
  lastAllowed = inMemoryLimit(key, 3, WINDOW).allowed;
}
check('the limit allows exactly `max` requests', lastAllowed, true);
check('request max+1 is blocked', inMemoryLimit(key, 3, WINDOW).allowed, false);
check(
  'a blocked response carries a positive Retry-After',
  inMemoryLimit(key, 3, WINDOW).retryAfterSeconds > 0,
  true
);

// A different caller must not inherit someone else's exhausted budget.
check(
  'a different key has its own budget',
  inMemoryLimit(`other:${Math.random()}`, 3, WINDOW).allowed,
  true
);

// A window that has already elapsed must reset rather than stay blocked
// forever — the bug that would silently lock out every user after a spike.
const expiring = `expire:${Math.random()}`;
inMemoryLimit(expiring, 1, 1);
await new Promise((r) => setTimeout(r, 5));
check('an elapsed window resets', inMemoryLimit(expiring, 1, 1).allowed, true);

// ── Caller identity ─────────────────────────────────────
// The user id must win over the IP: it is the only identifier a caller cannot
// trivially change, and keying a signed-in user by IP would make everyone
// behind one NAT share a budget.
const req = (headers: Record<string, string>) =>
  new Request('https://example.test/api/submit', { headers });

check(
  'an authenticated caller is keyed by user id',
  clientKey(req({ 'x-forwarded-for': '1.2.3.4' }), 'user-abc'),
  'user:user-abc'
);
check(
  'an anonymous caller is keyed by the leftmost forwarded address',
  clientKey(req({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1, 10.0.0.2' })),
  'ip:1.2.3.4'
);
check(
  'x-real-ip is the fallback',
  clientKey(req({ 'x-real-ip': '5.6.7.8' })),
  'ip:5.6.7.8'
);
check(
  'an unidentifiable caller gets the shared bucket',
  clientKey(req({})),
  'ip:unknown'
);

// ── Limit sanity ─────────────────────────────────────────
check('every limit is positive', Object.values(LIMITS).every((v) => v > 0), true);
check(
  'anonymous submitters get no more than signed-in ones',
  LIMITS.submitAnonymousPerHour >= LIMITS.submitPerUserPerHour ? 'anon >= user' : 'ok',
  'ok'
);

// ── Burst flattening ────────────────────────────────────
// The gate exists because /api/submit no longer blocks for the pipeline, so
// a seeding run starts a new one every few seconds while others run. If this
// is ever raised to the batch size, a burst stops being flattened at all.
check('concurrent drains are gated below the batch size', QUEUE_CONFIG.maxConcurrentDrains < QUEUE_CONFIG.batchSize, true);
check('at least one drain can run', QUEUE_CONFIG.maxConcurrentDrains >= 1, true);

console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
