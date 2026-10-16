/**
 * scripts/reembed-chunks.ts
 *
 * ONE-OFF MIGRATION: re-embeds every ProjectLearningChunk with the current
 * embedding model (Mistral mistral-embed, 1024 dimensions). Needed once, after
 * switching away from the old 768-dimension Gemini embeddings, because vectors
 * from different models cannot be compared.
 *
 * Safe to re-run: it only touches chunks whose stored embedding is missing or
 * not 1024 numbers long, and it picks up where an interrupted run stopped.
 * A chunk that fails is skipped (counted) and does not stop the run.
 *
 * Run from the backend folder:
 *   npx tsx --conditions=development -r tsconfig-paths/register src/scripts/reembed-chunks.ts --dry-run
 *   npx tsx --conditions=development -r tsconfig-paths/register src/scripts/reembed-chunks.ts
 *
 * Options:
 *   --dry-run     count what would be re-embedded; write nothing, call no API
 *   --limit=N     stop after N chunks (try a small run first)
 *   --batch=N     chunks per read/embed round (default 16)
 *
 * Needs MONGODB_URI, UPSTASH_REDIS_URL and MISTRAL_API_KEY in the environment.
 * Back up the collection first if you want a way back: this overwrites the
 * `embedding` field in place.
 */

import mongoose from 'mongoose';
import { connectDB } from '../loaders/db';
import { getRedis } from '../loaders/redis';
import { ProjectLearningChunk } from '../models';
import { embedTexts, EMBEDDING_DIMENSIONS } from '../lib/embeddings';

export interface ReembedOptions {
  dryRun:    boolean;
  limit?:    number;
  batchSize: number;
}

export interface ReembedStats {
  scanned:      number;
  updated:      number;
  skippedEmpty: number;
  failed:       number;
}

interface ChunkDoc {
  _id:                 unknown;
  embeddingInputText?: string;
  content?:            string;
}

/** Everything the loop needs from the outside world, so it can be tested. */
export interface ReembedDeps {
  findStale(afterId: unknown | null, limit: number): Promise<ChunkDoc[]>;
  saveEmbeddings(updates: Array<{ id: unknown; embedding: number[] }>): Promise<void>;
  embedTexts(texts: string[]): Promise<number[][]>;
  log(message: string): void;
}

export async function reembedAllChunks(options: ReembedOptions, deps: ReembedDeps): Promise<ReembedStats> {
  const stats: ReembedStats = { scanned: 0, updated: 0, skippedEmpty: 0, failed: 0 };
  let afterId: unknown | null = null;

  while (true) {
    const remaining = options.limit === undefined ? Infinity : options.limit - stats.scanned;
    if (remaining <= 0) break;

    const docs = await deps.findStale(afterId, Math.min(options.batchSize, remaining));
    if (docs.length === 0) break;

    // Cursor by _id so a chunk that keeps failing can't make the loop spin.
    afterId = docs[docs.length - 1]._id;
    stats.scanned += docs.length;

    const items = docs.map(d => ({ id: d._id, text: (d.embeddingInputText ?? d.content ?? '').trim() }));
    const usable = items.filter(i => i.text.length > 0);
    stats.skippedEmpty += items.length - usable.length;

    if (options.dryRun || usable.length === 0) continue;

    try {
      const vectors = await deps.embedTexts(usable.map(i => i.text));
      await deps.saveEmbeddings(usable.map((item, i) => ({ id: item.id, embedding: vectors[i] })));
      stats.updated += usable.length;
    } catch (batchErr) {
      // One bad chunk must not sink its neighbours — retry the batch one by one.
      deps.log(`batch failed (${batchErr instanceof Error ? batchErr.message : String(batchErr)}) — retrying chunk by chunk`);
      for (const item of usable) {
        try {
          const [vector] = await deps.embedTexts([item.text]);
          await deps.saveEmbeddings([{ id: item.id, embedding: vector }]);
          stats.updated++;
        } catch (err) {
          stats.failed++;
          deps.log(`chunk ${String(item.id)} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    deps.log(`progress: scanned ${stats.scanned}, updated ${stats.updated}, failed ${stats.failed}`);
  }

  return stats;
}

// ── Real wiring (MongoDB) ──────────────────────────────────────────────────

// Missing embedding, or one that is not exactly EMBEDDING_DIMENSIONS long.
const STALE_FILTER = {
  $or: [
    { embedding: { $exists: false } },
    { $expr: { $ne: [{ $size: { $ifNull: ['$embedding', []] } }, EMBEDDING_DIMENSIONS] } },
  ],
};

const mongoDeps: ReembedDeps = {
  async findStale(afterId, limit) {
    const idFilter = afterId ? { _id: { $gt: afterId } } : {};
    return ProjectLearningChunk
      .find({ $and: [idFilter, STALE_FILTER] })
      .sort({ _id: 1 })
      .limit(limit)
      .select('embeddingInputText content')
      .lean() as unknown as Promise<ChunkDoc[]>;
  },
  async saveEmbeddings(updates) {
    await ProjectLearningChunk.bulkWrite(
      updates.map(u => ({
        updateOne: { filter: { _id: u.id as never }, update: { $set: { embedding: u.embedding } } },
      })),
      { ordered: false },
    );
  },
  embedTexts: texts => embedTexts(texts, 'document'),
  log: message => console.log(`[reembed] ${message}`),
};

function parseArgs(argv: string[]): ReembedOptions {
  const num = (name: string): number | undefined => {
    const raw = argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
    const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return {
    dryRun:    argv.includes('--dry-run'),
    limit:     num('limit'),
    batchSize: num('batch') ?? 16,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await connectDB();

  const total = await ProjectLearningChunk.countDocuments(STALE_FILTER);
  console.log(`[reembed] ${total} chunk(s) need ${EMBEDDING_DIMENSIONS}-dimension embeddings` +
    (options.dryRun ? ' (dry run — nothing will be written)' : ''));

  const stats = await reembedAllChunks(options, mongoDeps);
  console.log('[reembed] done:', JSON.stringify(stats));
  if (stats.failed > 0) console.log('[reembed] some chunks failed — re-run the script to retry them.');

  await mongoose.connection.close();
  await getRedis().quit();
}

if (require.main === module) {
  main().catch(err => {
    console.error('[reembed] fatal:', err);
    process.exit(1);
  });
}
