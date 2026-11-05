import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
import { OUTING_CONFIG } from '../lib/config/outings';
import * as quality from '../lib/outings/quality';
import * as distance from '../lib/geo/distance';
async function run() {
  let routeCalls = 0;
  const restaurants = Array.from({ length: 6 }, (_, i) => ({ id: `r-${i}`, name: 'Test restaurant', city: 'Toronto', latitude: 43 + i / 100, longitude: -79, trend_state: 'ranked' }));
  const client = { from() { const q: any = { select() { return q; }, eq() { return q; }, not() { return q; }, order() { return q; }, limit: async () => ({ data: restaurants }) }; return q; } };
  const deps: Record<string, unknown> = {
    '@/lib/supabase/client': { supabase: client }, '@/lib/config/outings': { OUTING_CONFIG: { ...OUTING_CONFIG, useRoutesApi: true } },
    '@/lib/outings/quality': quality, '@/lib/geo/distance': distance,
    '@/lib/google/nearby': { findNearbyActivities: async (latitude: number) => [{ placeId: `park-${latitude}`, name: 'Test park', types: ['park'], primaryType: null, businessStatus: 'OPERATIONAL', category: 'park', latitude: latitude + 0.001, longitude: -79, googleRating: null, googleRatingCount: null }] },
    '@/lib/google/routes': { walkingLeg: async () => { routeCalls++; return { minutes: 30, metres: 2500, measured: true }; } },
  };
  const exports: any = {};
  const code = ts.transpileModule(readFileSync('lib/outings/pair.ts','utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Script(`(function(require,exports){${code}})`).runInNewContext({ console, Set, Map, process: { env: { GOOGLE_PLACES_API_KEY: 'offline-fixture' } } })((name: string) => deps[name], exports);
  const result = await exports.buildPairings({ limit: 3 });
  assert.equal(result.pairings.length, 0);
  assert.equal(routeCalls, 3);
  assert.equal(result.meta.routesCalled, 3);
  console.log('PASS long walking detours are excluded without exceeding the three-request Routes budget');
}
run().catch(e => { console.error(e); process.exitCode=1; });
