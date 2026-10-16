/**
 * lib/embeddings.ts
 *
 * WHAT: embedText() / embedTexts() turn text into 1024-number vectors via
 *       Mistral's `mistral-embed` model.
 *
 * DIMENSIONS: 1024. The Atlas Vector Search index "chunk_vector_index" must be
 * defined with numDimensions: 1024 and every stored chunk re-embedded with this
 * model — see MISTRAL-MIGRATION.md and src/scripts/reembed-chunks.ts. Vectors
 * from different models are NOT comparable, so never mix them in one index.
 *
 * USED BY (this is the ONE place embedding happens):
 *   - workers/jobs/knowledge-processing.job.ts → embeds chunks at ingest time
 *   - workers/jobs/gsc-monitor.job.ts          → embeds learnings
 *   - lib/vector-search.ts                     → embeds the query at retrieval time
 *
 * FAILURE BEHAVIOUR: callers already treat a failed embedding as "degraded, not
 * lost" (vector search falls back to text-only). So:
 *   - no MISTRAL_API_KEY            → fail IMMEDIATELY (no pointless retries)
 *   - 401/403 (bad key), 400/422    → permanent, not retried
 *   - 429 / 5xx / timeout / network → retried with backoff (3 attempts)
 *   - a batch Mistral rejects as too large is split in half automatically
 */

import { logger } from '../open-tele';
import { mistralPost, isMistralConfigured, MistralApiError } from './mistral';

const EMBEDDING_MODEL = 'mistral-embed';
const EMBEDDING_DIMS  = 1024;

const MAX_RETRIES          = 3;
const RETRY_BASE_DELAY_MS  = 500;
const MAX_RETRY_AFTER_MS   = 10_000;

// mistral-embed accepts up to 8192 tokens per input. ~3 chars per token is a
// deliberately pessimistic estimate (non-English scripts tokenise worse), so
// these limits err on the safe side. callers (chunker.ts) already keep chunks
// far below this.
const MAX_CHARS_PER_TEXT        = 20_000;
const CHARS_PER_TOKEN_ESTIMATE  = 3;
const MAX_EST_TOKENS_PER_REQUEST = 6_000;   // conservative per-request budget
const MAX_TEXTS_PER_REQUEST      = 32;

/**
 * Mistral's embedding model has no separate "query" / "document" modes, so this
 * is accepted for call-site readability and ignored.
 */
export type EmbeddingTask = 'document' | 'query';

interface MistralEmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);

/** Splits texts into request-sized groups (count + estimated-token budget). */
function groupForRequests(texts: string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const text of texts) {
    const tokens = estimateTokens(text);
    const wouldOverflow =
      current.length >= MAX_TEXTS_PER_REQUEST || currentTokens + tokens > MAX_EST_TOKENS_PER_REQUEST;
    if (current.length > 0 && wouldOverflow) {
      groups.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(text);
    currentTokens += tokens;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** One embeddings request for one group, with retries for transient failures. */
async function embedGroup(group: string[]): Promise<number[][]> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const start = Date.now();
    try {
      const res = await mistralPost<MistralEmbeddingResponse>(
        '/embeddings',
        { model: EMBEDDING_MODEL, input: group },
        { timeoutMs: 60_000, context: 'embeddings' },
      );

      const data = res.data ?? [];
      if (data.length !== group.length) {
        throw new Error(`Mistral returned ${data.length} embeddings for ${group.length} inputs`);
      }

      // Re-order by `index` so vectors line up with inputs even if the API reorders.
      const vectors = [...data]
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map(d => d.embedding);

      if (vectors.some(v => !Array.isArray(v) || v.length !== EMBEDDING_DIMS)) {
        throw new Error(
          `Unexpected embedding dimension: expected ${EMBEDDING_DIMS}, got ` +
          `${vectors.find(v => !Array.isArray(v) || v.length !== EMBEDDING_DIMS)?.length ?? 0}`,
        );
      }

      logger.debug('Texts embedded', { attempt, durationMs: Date.now() - start, count: group.length });
      return vectors as number[][];
    } catch (err) {
      lastErr = err;

      const status = err instanceof MistralApiError ? err.status : undefined;
      const transient =
        err instanceof MistralApiError && (status === 0 || status === 429 || (status !== undefined && status >= 500));

      logger.warn('embedding attempt failed', {
        attempt,
        maxRetries: MAX_RETRIES,
        count:      group.length,
        status,
        transient,
        error:      err instanceof Error ? err.message : String(err),
      });

      // Permanent failure (bad key, bad request, wrong shape): retrying cannot help.
      if (!transient || attempt === MAX_RETRIES) break;

      const retryAfter = err instanceof MistralApiError ? err.retryAfterMs : undefined;
      const backoff    = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      await sleep(Math.min(Math.max(backoff, retryAfter ?? 0), MAX_RETRY_AFTER_MS));
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** embedGroup, but a group the API rejects as invalid is split in half and retried. */
async function embedGroupAdaptive(group: string[]): Promise<number[][]> {
  try {
    return await embedGroup(group);
  } catch (err) {
    const rejected = err instanceof MistralApiError && (err.status === 400 || err.status === 413 || err.status === 422);
    if (rejected && group.length > 1) {
      const mid = Math.ceil(group.length / 2);
      logger.warn('Embedding request rejected — splitting batch', { count: group.length });
      const left  = await embedGroupAdaptive(group.slice(0, mid));
      const right = await embedGroupAdaptive(group.slice(mid));
      return [...left, ...right];
    }
    throw err;
  }
}

/**
 * Embeds many texts, in as few requests as the limits allow. Result order
 * matches input order. Throws if any text cannot be embedded.
 *
 * @param _task accepted for call-site readability; Mistral ignores it.
 */
export async function embedTexts(
  texts: string[],
  _task: EmbeddingTask = 'document',
): Promise<number[][]> {
  if (texts.length === 0) return [];

  texts.forEach((t, i) => {
    if (!t || !t.trim()) throw new Error(`embedTexts called with empty text at index ${i}`);
  });

  if (!isMistralConfigured()) {
    // Fail fast — retrying a missing key only wastes time.
    throw new Error('Embeddings unavailable: MISTRAL_API_KEY is not set');
  }

  const prepared = texts.map(t => (t.length > MAX_CHARS_PER_TEXT ? t.slice(0, MAX_CHARS_PER_TEXT) : t));

  try {
    const out: number[][] = [];
    // Sequential on purpose: Mistral's free tier is 1 request/second, and the
    // shared slot gate in lib/mistral.ts spaces these out.
    for (const group of groupForRequests(prepared)) {
      out.push(...(await embedGroupAdaptive(group)));
    }
    return out;
  } catch (err) {
    throw new Error(
      `embedTexts failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Embeds one text. Same failure behaviour as embedTexts. */
export async function embedText(text: string, task: EmbeddingTask = 'document'): Promise<number[]> {
  if (!text || !text.trim()) {
    throw new Error('embedText called with empty text');
  }
  const [vector] = await embedTexts([text], task);
  return vector;
}

export const EMBEDDING_DIMENSIONS = EMBEDDING_DIMS;
