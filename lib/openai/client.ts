/**
 * OpenAI embeddings.
 *
 * Deliberately `fetch` rather than the `openai` SDK: this needs exactly one
 * endpoint, and the SDK is a dependency, a bundle-size cost and another thing
 * to keep in step with Next's runtime for no benefit here.
 *
 * WHAT THIS IS FOR: dish matching. The rule-based normalizer handles
 * "Matcha Croissants" -> "matcha croissant" and now folds accents, but it
 * cannot know that "birria tacos" and "quesabirria" are the same thing, or
 * that "matcha croissant" and "matcha latte" are not. Embeddings give that
 * semantically instead of requiring a hand-maintained alias for every pair.
 */

export const EMBEDDING_MODEL = 'text-embedding-3-small';

/** The embedding dimension `dishes.embedding` is declared with. */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Recorded in `dishes.embedding_model` alongside the model name.
 *
 * Bump this whenever the text handed to the embedder changes — see
 * dishEmbeddingInput below. Two vectors are only comparable if they were
 * produced from the same model AND the same input recipe, and a silent change
 * to the recipe would make old and new rows quietly incomparable, which looks
 * like the matcher randomly getting worse. Storing it means a backfill can
 * find the rows that need redoing.
 */
export const EMBEDDING_INPUT_VERSION = 'v1';

export const EMBEDDING_MODEL_TAG = `${EMBEDDING_MODEL}/${EMBEDDING_INPUT_VERSION}`;

/** OpenAI caps a single embeddings request; stay well under it. */
const MAX_BATCH = 96;

const MAX_ATTEMPTS = 3;

export class OpenAIError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'OpenAIError';
    this.status = status;
  }
}

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new OpenAIError(
      'OPENAI_API_KEY is not set. Dish embedding is disabled without it.'
    );
  }
  return key;
}

/** Is embedding available at all? Lets callers degrade instead of throwing. */
export function isEmbeddingConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * The exact text embedded for a dish.
 *
 * The normalized name, nothing else. Two alternatives were considered and
 * rejected: the raw caption text (noisy, and it would make the same dish
 * embed differently depending on who wrote about it) and a sentence template
 * like "a dish called X" (the shared wording dominates the vector and pushes
 * every dish closer together, which is the opposite of what is needed).
 *
 * If this changes, bump EMBEDDING_INPUT_VERSION.
 */
export function dishEmbeddingInput(normalizedName: string): string {
  return normalizedName.trim().toLowerCase();
}

async function post(inputs: string[]): Promise<number[][]> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: inputs }),
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const retryable = response.status === 429 || response.status >= 500;
        const err = new OpenAIError(
          `Embeddings request failed (${response.status}): ${body.slice(0, 200)}`,
          response.status
        );
        if (!retryable || attempt === MAX_ATTEMPTS) throw err;
        lastError = err;
      } else {
        const json = await response.json();
        const data = json?.data;
        if (!Array.isArray(data) || data.length !== inputs.length) {
          throw new OpenAIError(
            `Embeddings response had ${data?.length ?? 0} vectors for ${inputs.length} inputs`
          );
        }
        // The API documents that results come back in input order, but it
        // also returns an index on each. Sort by it rather than trusting the
        // order: a silent misalignment here would attach every dish's vector
        // to a different dish, which no test downstream would catch.
        return [...data]
          .sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))
          .map((row: any) => {
            if (!Array.isArray(row.embedding)) {
              throw new OpenAIError('Embeddings response row had no vector');
            }
            if (row.embedding.length !== EMBEDDING_DIMENSIONS) {
              throw new OpenAIError(
                `Expected ${EMBEDDING_DIMENSIONS} dimensions, got ${row.embedding.length}`
              );
            }
            return row.embedding as number[];
          });
      }
    } catch (err: any) {
      if (err?.name === 'OpenAIError' && err.status && err.status < 500 && err.status !== 429) {
        throw err;
      }
      lastError = err;
      if (attempt === MAX_ATTEMPTS) break;
    }

    await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** (attempt - 1)));
  }

  throw lastError instanceof Error
    ? lastError
    : new OpenAIError('Embeddings request failed');
}

/** Embed one string. */
export async function embed(text: string): Promise<number[]> {
  const [vector] = await embedBatch([text]);
  return vector;
}

/**
 * Embed many strings, chunked.
 *
 * Used by the backfill: one request per 96 names rather than one per name
 * turns a few hundred round trips into a handful.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const cleaned = texts.map((t) => t.trim()).filter((t) => t.length > 0);
  if (cleaned.length !== texts.length) {
    throw new OpenAIError('Cannot embed an empty string');
  }
  if (cleaned.length === 0) return [];

  const out: number[][] = [];
  for (let i = 0; i < cleaned.length; i += MAX_BATCH) {
    out.push(...(await post(cleaned.slice(i, i + MAX_BATCH))));
  }
  return out;
}

/**
 * Serialise a vector for pgvector.
 *
 * pgvector's text input format is "[0.1,0.2,...]", which is also valid JSON,
 * so PostgREST sends it as a string and Postgres casts it to `vector`.
 *
 * Verified against the live database: te_similar_dishes accepts this form.
 * It also accepted a raw JS array, so both appear to work for an RPC
 * argument — this is used anyway because it is the form Supabase documents,
 * it is unambiguous about the intended type, and it keeps the RPC argument
 * and the column write identical rather than relying on two different casts
 * behaving the same way.
 */
export function toPgVector(vector: number[]): string {
  return JSON.stringify(vector);
}
