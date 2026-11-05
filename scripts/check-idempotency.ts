import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
function queries(client: unknown): any {
  const code = ts.transpileModule(readFileSync('lib/supabase/queries.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const deps: Record<string, unknown> = { './client': { supabase: client }, '@/lib/config/pipeline': { QUEUE_CONFIG: {}, isTerminalStatus: () => false } };
  new Script(`(function(require,exports){${code}})`).runInNewContext({ console })((id: string) => { assert.ok(id in deps); return deps[id]; }, exports);
  return exports;
}
async function main() {
  const rows: any[] = [];
  const client = { from(table: string) {
    let value: any;
    const filters: Record<string, any> = {};
    const builder: any = {
      insert(v: any) { value = v; return builder; }, select() { return builder; },
      eq(k: string, v: any) { filters[k] = v; return builder; }, in() { return builder; }, order() { return builder; }, limit() { return builder; },
      async single() {
        assert.equal(table, 'raw_submissions');
        if (rows.some(r => r.tiktok_video_id === value.tiktok_video_id)) return { error: { code: '23505' } };
        const row = { ...value, id: `queue-${rows.length + 1}` }; rows.push(row); return { data: row };
      },
      async maybeSingle() { return { data: rows.find(r => Object.entries(filters).every(([k,v]) => r[k] === v)) ?? null }; },
    };
    return builder;
  } };
  const q = queries(client);
  const results = await Promise.all([q.createRawSubmission('https://www.tiktok.com/@test/video/123', null, '123'), q.createRawSubmission('https://www.tiktok.com/@test/video/123', null, '123')]);
  assert.equal(rows.length, 1); assert.equal(results[0], results[1]);
  console.log('PASS concurrent queue insert conflict returns the same submission ID');
  const reviewQueries = queries({ from() { const chain: any = { insert() { return chain; }, select() { return chain; }, eq() { return chain; }, limit() { return chain; }, single: async () => ({ error: { code: '23505' } }), maybeSingle: async () => ({ data: { id: 'existing-review' } }) }; return chain; } });
  const id = await reviewQueries.createReview('restaurant', 'submission', { videoId: '123' }, { isSponsored: false });
  assert.equal(id, 'existing-review');
  console.log('PASS unique-review conflict reuses saved review instead of creating another');
  console.log('Idempotency checks: 2 passed (database uniqueness migration is required)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
