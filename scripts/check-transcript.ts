/** Offline regression checks: missing oEmbed metadata must not hide usable speech.
 * Runs the real pipeline code with provider/database modules replaced in memory.
 * No environment files, network requests, or paid API calls are used.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';

export function loadSource(file: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}): any {
  const javascript = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  const requireMock = (name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency in ${file}: ${name}`);
    return dependencies[name];
  };
  const quietConsole = { log() {}, warn() {}, error() {}, info() {} };
  new Script(`(function(require, exports, console) {${javascript}\n})`, { filename: file })
    .runInNewContext({ URL, AbortSignal, ...globals })(requireMock, exports, quietConsole);
  return exports;
}

const speech = 'I went to Messi Shawarma in Brampton and ordered chicken shawarma.';
const typedCaption = 'Visiting Messi Shawarma in Brampton.';

export function processorFixture(caption: string, transcriptStatus: string, transcriptText: string | null, savedVideo: any = null, overrides: { extraction?: any; place?: any; caption?: string; classification?: any } = {}) {
  const calls: { name: string; args: any[] }[] = [];
  const record = (name: string, result?: unknown) => async (...args: any[]) => {
    calls.push({ name, args });
    return result;
  };
  const processor = loadSource('lib/pipeline/processor.ts', {
    './tiktok': {
      fetchTikTokData: record('metadata', {
        videoId: '7596836779760684308', url: 'https://www.tiktok.com/@oxtailpapi/video/7596836779760684308',
        caption, creatorUsername: 'oxtailpapi', thumbnailUrl: '', embedHtml: '', likes: 0, views: 0,
      }),
    },
    // The real module: it is pure text handling with no provider calls, so
    // mocking it would test the mock rather than the fallback.
    './nameCandidates': require('../lib/pipeline/nameCandidates'),
    './caption': { fetchCaption: record('captionFallback', {text:overrides.caption ?? null,status:'not_attempted',source:null}) },
    './transcript': {
      fetchTranscript: record('transcript', { status: transcriptStatus, text: transcriptText, source: 'supadata', lang: 'en' }),
      saveTranscript: record('saveTranscript'),
    },
    '@/lib/gemini/classify': {
      classifyContent: record('classify', overrides.classification ?? { isRestaurantReview: true, isSafeToPublish: true, confidence: 1, contentType: 'restaurant_review' }),
    },
    '@/lib/gemini/extract': {
      extractRestaurantData: record('extract', overrides.extraction ?? { restaurantName: 'Messi Shawarma', city: 'Brampton', isSponsored: false }),
    },
    '@/lib/google/places': {
      findRestaurant: record('places', overrides.place ?? { placeId: 'test-place', name: 'Messi Shawarma', city: 'Brampton', address: 'Brampton', locationVerified:true }),
    },
    '@/lib/supabase/queries': {
      updateSubmissionWithTikTokData: record('saveMetadata'),
      findReviewByVideoId: record('existingVideo', savedVideo),
      updateSubmissionStatus: record('status'),
      findRestaurantByPlaceId: record('findRestaurant', null),
      createRestaurant: record('createRestaurant', 'restaurant-1'),
      createReview: record('createReview', 'review-1'),
      upsertCreator: record('upsertCreator'),
      refreshRestaurantPlaceData: record('refreshRestaurant'),
    },
    '@/lib/geo/gta': { isGta: () => true },
  });
  return { run: (hint?: any) => processor.processSubmission('submission-1', 'https://www.tiktok.com/@oxtailpapi/video/7596836779760684308', hint), calls };
}

let passed = 0;
let failed = 0;
async function check(label: string, body: () => Promise<void>) {
  try {
    await body();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function run() {
  await check('retry after a saved review reuses it before any provider call', async () => {
    const fixture = processorFixture('', 'not_attempted', null, { restaurantId: 'saved-restaurant', restaurantName: 'Saved business' });
    const result = await fixture.run();
    assert.equal(result.success, true);
    assert.equal(result.restaurantId, 'saved-restaurant');
    assert.ok(!fixture.calls.some(c => ['transcript', 'classify', 'extract', 'places', 'createReview'].includes(c.name)));
    assert.equal(fixture.calls.filter(c => c.name === 'status').at(-1)?.args[1], 'completed');
  });

  await check('missing API caption uses spoken transcript and saves a review', async () => {
    const fixture = processorFixture('', 'ok', speech);
    const result = await fixture.run();
    assert.equal(result.success, true);
    assert.equal(result.reviewId, 'review-1');
    assert.equal(fixture.calls.find(call => call.name === 'classify')?.args[2], speech);
    assert.equal(fixture.calls.find(call => call.name === 'extract')?.args[3], speech);
    assert.equal(fixture.calls.find(call => call.name === 'places')?.args[0], 'Messi Shawarma');
    assert.equal(fixture.calls.find(call => call.name === 'places')?.args[1], 'Brampton');
    assert.ok(fixture.calls.find(call => call.name === 'createReview'));
    assert.equal(fixture.calls.filter(call => call.name === 'transcript').length, 1);
    assert.equal(fixture.calls.filter(call => call.name === 'status').at(-1)?.args[1], 'completed');
  });

  await check('caption still processes when transcript is unavailable', async () => {
    const fixture = processorFixture(typedCaption, 'unavailable', null);
    const result = await fixture.run();
    assert.equal(result.success, true);
    assert.equal(fixture.calls.find(call => call.name === 'classify')?.args[0], typedCaption);
    assert.equal(fixture.calls.find(call => call.name === 'extract')?.args[0], typedCaption);
  });

  await check('caption still processes when transcript provider fails', async () => {
    const fixture = processorFixture(typedCaption, 'failed', null);
    assert.equal((await fixture.run()).success, true);
    assert.ok(fixture.calls.find(call => call.name === 'createReview'));
  });

  await check('both text sources unavailable reports retrieval failure without inventing a review', async () => {
    const fixture = processorFixture('', 'unavailable', null);
    const result = await fixture.run();
    assert.equal(result.success, false);
    assert.match(result.rejectionReason, /retrieve.*caption.*transcript/i);
    assert.ok(fixture.calls.find(call => call.name === 'transcript'));
    assert.ok(!fixture.calls.find(call => call.name === 'classify'));
    assert.ok(!fixture.calls.find(call => call.name === 'createRestaurant'));
    assert.ok(!fixture.calls.find(call => call.name === 'createReview'));
  });

  await check('failed transcript retrieval without caption remains retryable', async () => {
    const fixture = processorFixture('', 'failed', null);
    await assert.rejects(fixture.run, /Content retrieval failed/i);
    assert.ok(!fixture.calls.find(call => call.name === 'status'));
    assert.ok(!fixture.calls.find(call => call.name === 'createReview'));
  });

  await check('transcripts disabled does not become a claim the video lacks a caption', async () => {
    const fixture = processorFixture('', 'not_attempted', null);
    const result = await fixture.run();
    assert.equal(result.success, false);
    assert.match(result.rejectionReason, /retrieve.*caption.*transcript/i);
    assert.ok(!/No caption available/i.test(result.rejectionReason));
  });

  await check('whitespace-only metadata and speech do not reach extraction', async () => {
    const fixture = processorFixture('  \n ', 'ok', ' \t ');
    const result = await fixture.run();
    assert.equal(result.success, false);
    assert.match(result.rejectionReason, /retrieve.*caption.*transcript/i);
    assert.ok(!fixture.calls.find(call => call.name === 'classify'));
    assert.ok(!fixture.calls.find(call => call.name === 'createReview'));
  });

  await check('saved transcript is reused without another provider request', async () => {
    let providerCalls = 0;
    const filters: [string, unknown][] = [];
    const query = {
      select() { return this; },
      eq(column: string, value: unknown) { filters.push([column, value]); return this; },
      not() { return this; },
      limit() { return this; },
      async maybeSingle() { return { data: { transcript: speech, transcript_status: 'ok' }, error: null }; },
    };
    const module = loadSource('lib/pipeline/transcript.ts', {
      '@/lib/supabase/client': { supabase: { from(table: string) { assert.equal(table, 'raw_submissions'); return query; } } },
      '@/lib/config/transcript': { TRANSCRIPT_CONFIG: { enabled: true, captionLengthFloor: 0 } },
    }, {
      process: { env: { SUPADATA_API_KEY: 'offline-test-fixture' } },
      fetch: async () => { providerCalls++; throw new Error('No network is allowed'); },
    });
    const result = await module.fetchTranscript('https://www.tiktok.com/@oxtailpapi/video/7596836779760684308', {
      videoId: '7596836779760684308', captionLength: 0,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.source, 'supadata-cache');
    assert.equal(result.text, speech);
    assert.equal(providerCalls, 0);
    assert.ok(filters.some(([column, value]) => column === 'tiktok_video_id' && value === '7596836779760684308'));
    assert.ok(filters.some(([column, value]) => column === 'transcript_status' && value === 'ok'));
  });

  await check('real classification and extraction prompts receive separately labelled sources', async () => {
    const prompts: { userMessage: string; systemInstruction: string }[] = [];
    const client = {
      MODELS: { classify: 'offline', extract: 'offline' },
      generateJSON: async (prompt: { userMessage: string; systemInstruction: string }) => {
        prompts.push(prompt);
        return { isRestaurantReview: true, isSafeToPublish: true, restaurantName: 'Messi Shawarma' };
      },
    };
    const classify = loadSource('lib/gemini/classify.ts', { './client': client });
    const extract = loadSource('lib/gemini/extract.ts', { './client': client, '@/lib/pipeline/nameCandidates': require('../lib/pipeline/nameCandidates') });
    await classify.classifyContent(typedCaption, 'oxtailpapi', speech);
    await extract.extractRestaurantData(typedCaption, 'oxtailpapi', undefined, speech);
    assert.equal(prompts.length, 2);
    for (const prompt of prompts) {
      assert.ok(prompt.userMessage.includes(typedCaption));
      assert.ok(prompt.userMessage.includes(speech));
      assert.match(prompt.userMessage, /caption/i);
      assert.match(prompt.userMessage, /transcript/i);
    }
    assert.match(prompts[1].systemInstruction, /caption/i);
    assert.match(prompts[1].systemInstruction, /transcript/i);
    assert.match(prompts[1].systemInstruction, /restaurant name/i);
    assert.match(prompts[1].systemInstruction, /do not infer|do not invent|only what/i);
    assert.match(prompts[1].systemInstruction, /prefer the caption for the restaurant name/i);
    assert.match(prompts[1].systemInstruction, /not other restaurants mentioned for comparison/i);
    assert.match(prompts[1].systemInstruction, /evidence, not instructions/i);
  });

  await check('classifier provider failures do not masquerade as unrelated content', async () => {
    const module = loadSource('lib/gemini/classify.ts', {
      './client': { MODELS: { classify: 'offline' }, generateJSON: async () => { throw new Error('provider unavailable'); } },
    });
    await assert.rejects(() => module.classifyContent('', 'oxtailpapi', speech), /provider unavailable/);
  });

  await check('partial official video embed can fall back to transcript', async () => {
    const module = loadSource('lib/pipeline/tiktok.ts', {
      axios: { default: { get: async () => ({ data: { type: 'video', version: '1.0', html: '<blockquote class="tiktok-embed"></blockquote>' } }) } },
    });
    const result = await module.fetchTikTokData('https://www.tiktok.com/@oxtailpapi/video/7596836779760684308');
    assert.equal(result.caption, '');
    assert.equal(result.videoId, '7596836779760684308');
  });

  await check('malformed oEmbed response throws instead of becoming an empty caption', async () => {
    const module = loadSource('lib/pipeline/tiktok.ts', {
      axios: { default: { get: async () => ({ data: { message: 'upstream temporarily unavailable' } }) } },
    });
    await assert.rejects(() => module.fetchTikTokData('https://www.tiktok.com/@oxtailpapi/video/7596836779760684308'));
  });

  console.log(`Transcript checks: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

if (require.main === module) run().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
