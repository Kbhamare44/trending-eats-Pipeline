/**
 * Offline checks for the submission queue's pure logic.
 *
 * No network, no database. What is covered here is the part that decides
 * whether a link is accepted at all and whether it is a duplicate — get
 * either wrong and you either reject real submissions or pay for the whole
 * Gemini + Places pipeline twice for the same video.
 */

import {
  extractVideoId,
  isSubmittableTikTokUrl,
} from '../lib/pipeline/tiktok';
import { QUEUE_CONFIG, isTerminalStatus } from '../lib/config/pipeline';

let passed = 0;
let failed = 0;

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
