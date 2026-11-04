/**
 * Backfill embeddings for dishes that do not have one.
 *
 * Run after adding the embedding column, after a model change, or whenever
 * EMBEDDING_INPUT_VERSION is bumped — vectors are only comparable to others
 * produced by the same model AND the same input text, so a mixed table
 * degrades matching in a way that looks like the matcher randomly getting
 * worse. `dishes.embedding_model` records both, which is how this script
 * finds the rows that need redoing.
 *
 *   npx tsx scripts/backfill-embeddings.ts            # missing only
 *   npx tsx scripts/backfill-embeddings.ts --stale    # also wrong-model rows
 *   npx tsx scripts/backfill-embeddings.ts --dry-run
 *
 * There are currently zero dishes, so this will report nothing to do until
 * content is seeded. That is the expected first result, not a failure.
 */

import { supabase } from '../lib/supabase/client';
import {
  embedBatch,
  toPgVector,
  dishEmbeddingInput,
  isEmbeddingConfigured,
  EMBEDDING_MODEL_TAG,
} from '../lib/openai/client';
import { normalizeDishName } from '../lib/dishes/normalize';

const BATCH = 96;

interface DishRow {
  id: string;
  name: string;
  slug: string;
  embedding_model: string | null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const includeStale = args.includes('--stale');

  if (!isEmbeddingConfigured()) {
    console.error('OPENAI_API_KEY is not set. Nothing to do.');
    process.exit(1);
  }

  console.log(`Model tag: ${EMBEDDING_MODEL_TAG}`);

  // Rows with no vector at all.
  const { data: missing, error: missingError } = await supabase
    .from('dishes')
    .select('id, name, slug, embedding_model')
    .is('embedding', null);

  if (missingError) {
    console.error('Could not read dishes:', missingError.message);
    process.exit(1);
  }

  let targets: DishRow[] = (missing ?? []) as DishRow[];

  if (includeStale) {
    const { data: stale, error: staleError } = await supabase
      .from('dishes')
      .select('id, name, slug, embedding_model')
      .not('embedding', 'is', null)
      .neq('embedding_model', EMBEDDING_MODEL_TAG);

    if (staleError) {
      console.error('Could not read stale rows:', staleError.message);
    } else {
      const seen = new Set(targets.map((t) => t.id));
      for (const row of (stale ?? []) as DishRow[]) {
        if (!seen.has(row.id)) targets.push(row);
      }
    }
  }

  if (targets.length === 0) {
    console.log('\nNothing to embed. Every dish has a current vector.');
    return;
  }

  console.log(`\n${targets.length} dish(es) to embed${dryRun ? ' (dry run)' : ''}:`);
  for (const row of targets.slice(0, 10)) {
    console.log(`  ${row.slug}${row.embedding_model ? `  [was ${row.embedding_model}]` : ''}`);
  }
  if (targets.length > 10) console.log(`  … and ${targets.length - 10} more`);

  if (dryRun) return;

  let embedded = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);

    // Embed the NORMALIZED name, matching exactly what resolveDish() embeds.
    // Embedding the display name instead would put differently-cased or
    // differently-pluralised text through the model than the live path does,
    // and the two sets of vectors would not be properly comparable.
    const inputs = chunk.map((row) =>
      dishEmbeddingInput(normalizeDishName(row.name) || row.slug.replace(/-/g, ' '))
    );

    try {
      const vectors = await embedBatch(inputs);

      for (let j = 0; j < chunk.length; j++) {
        const { error } = await supabase
          .from('dishes')
          .update({
            embedding: toPgVector(vectors[j]),
            embedding_model: EMBEDDING_MODEL_TAG,
            embedded_at: new Date().toISOString(),
          })
          .eq('id', chunk[j].id);

        if (error) {
          failed++;
          console.error(`  FAIL ${chunk[j].slug}: ${error.message}`);
        } else {
          embedded++;
        }
      }

      console.log(`  embedded ${Math.min(i + BATCH, targets.length)}/${targets.length}`);
    } catch (err: any) {
      failed += chunk.length;
      console.error(`  batch failed: ${err.message}`);
    }
  }

  console.log(`\nembedded: ${embedded}  failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
