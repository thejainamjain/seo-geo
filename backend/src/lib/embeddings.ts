/**
 * lib/embeddings.ts
 *
 * WHAT: Single function — embedText() — that turns a string into a 768-number
 *       vector via Gemini's `text-embedding-004` model.
 *
 * WHY GEMINI EMBEDDINGS: Free with the API key this project already has
 * (config.gemini.apiKey()) — no new provider, no new billing relationship.
 * 768 dimensions matches what ProjectLearningChunk.embedding and the Atlas
 * Vector Search index (see docs/13-knowledge-learning-system.md) both expect.
 * Reuses the same lazy GoogleGenerativeAI singleton as lib/llm.ts
 * (getGenAI(), exported from there) rather than creating a second client.
 *
 * USED BY (both — this is the ONE place embedding happens, ever):
 *   - workers/jobs/knowledge-processing.job.ts → embeds ProjectKnowledgeFile
 *     chunks (sourceType: "knowledge_file")
 *   - workers/jobs/gsc-monitor.job.ts → embeds BlogLearning insights
 *     (sourceType: "learning")
 *   - lib/vector-search.ts → embeds the query text at retrieval time
 *
 * RETRY: 3 attempts, exponential backoff (500ms, 1000ms, 2000ms). Embedding
 * calls are cheap/fast compared to generation calls, so a tighter retry
 * loop here (rather than relying on BullMQ's job-level retry) avoids
 * re-running an entire chunking job over one transient embedding failure.
 *
 * FAILURE MODE: throws after all retries exhausted. Callers decide what
 * "no embedding" means for them — knowledge-processing.job.ts fails that
 * one chunk and continues with the rest (partial knowledge beats none);
 * gsc-monitor.job.ts still keeps the BlogLearning record even if embedding
 * fails (the insight is still visible in the feed even if it's not yet
 * retrievable by vector search — degraded, not lost).
 */

import { getGenAI } from './llm';
import { logger }   from '../open-tele';
import { TaskType } from '@google/generative-ai';

const EMBEDDING_MODEL   = 'text-embedding-004';
const EMBEDDING_DIMS    = 768;
const MAX_RETRIES       = 3;
const RETRY_BASE_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Converts text into a 768-number vector representing its meaning.
 *
 * @param text The text to embed. Gemini's embedding model truncates around
 *             ~2048 tokens — callers (chunker.ts) are responsible for
 *             staying under that via chunk sizing, not this function.
 * @param taskType Gemini embedding models support task-specific embeddings
 *             (a query and the documents it searches over are embedded
 *             slightly differently for better retrieval accuracy).
 *             Defaults to TaskType.RETRIEVAL_DOCUMENT (embedding a chunk to
 *             be stored); pass TaskType.RETRIEVAL_QUERY when embedding a
 *             search query at retrieval time.
 */
export async function embedText(
  text: string,
  taskType: TaskType.RETRIEVAL_DOCUMENT | TaskType.RETRIEVAL_QUERY = TaskType.RETRIEVAL_DOCUMENT,
): Promise<number[]> {
  if (!text || !text.trim()) {
    throw new Error('embedText called with empty text');
  }

  const model = getGenAI().getGenerativeModel({ model: EMBEDDING_MODEL });

  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const start = Date.now();
    try {
      const result = await model.embedContent({
        content:  { role: 'user', parts: [{ text }] },
        taskType,
      });

      const values = result.embedding.values;

      if (!values || values.length !== EMBEDDING_DIMS) {
        throw new Error(
          `Unexpected embedding dimension: got ${values?.length ?? 0}, expected ${EMBEDDING_DIMS}`,
        );
      }

      logger.debug('Text embedded', {
        attempt,
        durationMs: Date.now() - start,
        chars:      text.length,
        taskType,
      });

      return values;
    } catch (err) {
      lastErr = err;
      logger.warn('embedText attempt failed', {
        attempt,
        maxRetries: MAX_RETRIES,
        error:      err instanceof Error ? err.message : String(err),
      });

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }

  throw new Error(
    `embedText failed after ${MAX_RETRIES} attempts: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

/**
 * Embeds multiple texts in one batched API call — cheaper and faster than
 * calling embedText() in a loop. Use for chunking a whole document at once.
 *
 * NOTE: Gemini's batchEmbedContents has its own request-size limits (100
 * requests per batch as of this writing) — chunker.ts callers should batch
 * in groups of ~50 to stay comfortably under that, not send an entire large
 * document's chunks in a single call.
 */
export async function embedTexts(
  texts: string[],
  taskType: TaskType.RETRIEVAL_DOCUMENT | TaskType.RETRIEVAL_QUERY = TaskType.RETRIEVAL_DOCUMENT,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const model = getGenAI().getGenerativeModel({ model: EMBEDDING_MODEL });

  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const start = Date.now();
    try {
      const result = await model.batchEmbedContents({
        requests: texts.map(text => ({
          content:  { role: 'user', parts: [{ text }] },
          taskType,
        })),
      });

      const vectors = result.embeddings.map(e => e.values);

      if (vectors.some(v => !v || v.length !== EMBEDDING_DIMS)) {
        throw new Error('One or more embeddings in batch had unexpected dimensions');
      }

      logger.debug('Batch text embedded', {
        attempt,
        durationMs: Date.now() - start,
        count:      texts.length,
        taskType,
      });

      return vectors;
    } catch (err) {
      lastErr = err;
      logger.warn('embedTexts batch attempt failed', {
        attempt,
        maxRetries: MAX_RETRIES,
        count:      texts.length,
        error:      err instanceof Error ? err.message : String(err),
      });

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }

  throw new Error(
    `embedTexts failed after ${MAX_RETRIES} attempts: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

export const EMBEDDING_DIMENSIONS = EMBEDDING_DIMS;
