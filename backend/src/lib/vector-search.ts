/**
 * lib/vector-search.ts
 *
 * WHAT: Hybrid retrieval (vector + BM25, fused with RRF) against
 *       ProjectLearningChunk — the single collection that holds both
 *       brand-knowledge chunks (sourceType: "knowledge_file") and learning
 *       chunks (sourceType: "learning"), scoped by projectId.
 *
 * WHY ONE FUNCTION FOR BOTH: LEARNING_SYSTEM_ARCHITECTURE.md (Section 5)
 * describes two separate collections (projectknowledgechunks,
 * projectlearningchunks) with near-identical query logic duplicated across
 * both. This codebase already made the better call — one collection, one
 * retrieval function, filtered by sourceType. Same infra, same index, same
 * RRF logic, no duplicated aggregation pipeline to keep in sync.
 *
 * MULTI-TENANCY — CRITICAL RULE (per the architecture doc's own standard,
 * and this codebase's existing "every query needs a projectId" pattern):
 * projectId is a required, non-optional parameter on every exported
 * function here. There is no code path that queries this collection
 * without it.
 *
 * HYBRID SEARCH: runs Atlas $vectorSearch and Atlas $search (BM25) as two
 * separate aggregations (Atlas doesn't support both in one pipeline stage
 * against the same collection), then fuses client-side with Reciprocal
 * Rank Fusion: score = Σ 1/(rank + 60) per result across whichever list(s)
 * it appears in.
 *
 * REQUIRES (cannot be created in code — see docs/13-knowledge-learning-system.md):
 *   Atlas Search index "chunk_vector_index" ($vectorSearch, field: embedding)
 *   Atlas Search index "chunk_text_index"   ($search / BM25, field: content, keyword)
 *
 * DEGRADED MODE: if the Atlas Search indexes don't exist yet (fresh
 * environment, or Atlas Search unavailable in this deployment tier), the
 * $vectorSearch / $search aggregation stages throw. Both search functions
 * catch that specific failure and log + return an empty result rather than
 * failing the caller — matches this codebase's existing philosophy
 * (partial result beats no result) and means blog generation still works,
 * just without RAG context, exactly like it does today before this system
 * existed.
 */

import mongoose from 'mongoose';
import { ProjectLearningChunk } from '../models';
import { embedText } from './embeddings';
import { logger } from '../open-tele';

const VECTOR_INDEX_NAME = 'chunk_vector_index';
const TEXT_INDEX_NAME   = 'chunk_text_index';

const VECTOR_CANDIDATES = 100; // numCandidates for $vectorSearch — over-fetch before limiting
const HYBRID_TOP_N      = 20;  // each of vector/text search contributes up to this many to RRF
const RRF_K              = 60;  // standard RRF constant — prevents any single outlier rank from dominating

// cosine — below this, a chunk isn't relevant enough to inject. 0.75 was tuned
// for the previous embedding model; similarity scores are NOT comparable across
// models, so after switching to mistral-embed check the "Vector search scores"
// debug log on a few real queries and tune it with VECTOR_SIMILARITY_THRESHOLD.
function similarityThreshold(): number {
  const parsed = Number.parseFloat(process.env.VECTOR_SIMILARITY_THRESHOLD ?? '');
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.75;
}

export interface RetrievedChunk {
  _id:         string;
  content:     string;
  sourceType:  string;
  sectionTitle?: string;
  classifiedTrustLevel?: string;
  confidence?: number;
  keyword?:    string;
  score:       number; // RRF fused score — comparable across chunks in the same result set, not a raw similarity
}

interface HybridSearchOptions {
  projectId:   string;
  queryText:   string;
  sourceTypes: Array<'knowledge_file' | 'blog' | 'audit' | 'learning'>;
  topK:        number;
  /** Excludes chunks with classifiedTrustLevel: "LOW" — defaults true, matching the architecture doc's quality gate. */
  excludeLowTrust?: boolean;
  /** Only include learning chunks with confidence >= this value (0-1 scale — BlogLearning uses numeric confidence, not the doc's HIGH/MEDIUM/LOW strings). Defaults to 0.5 (~ MEDIUM and above). */
  minLearningConfidence?: number;
}

/**
 * Runs Atlas $vectorSearch, returns ranked chunk _ids with similarity scores.
 * Returns [] (not a throw) if the index is missing/unavailable — see module
 * doc comment on degraded mode.
 */
async function runVectorSearch(
  projectId: string,
  queryVector: number[],
  sourceTypes: string[],
): Promise<Array<{ _id: string; score: number }>> {
  try {
    const results = await ProjectLearningChunk.aggregate([
      {
        $vectorSearch: {
          index:         VECTOR_INDEX_NAME,
          path:          'embedding',
          queryVector,
          numCandidates: VECTOR_CANDIDATES,
          limit:         HYBRID_TOP_N,
          filter: {
            projectId:  new mongoose.Types.ObjectId(projectId),
            sourceType: { $in: sourceTypes },
          },
        },
      },
      {
        $project: {
          _id:   1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ]);

    const threshold = similarityThreshold();
    logger.debug('Vector search scores', {
      projectId,
      threshold,
      returned: results.length,
      topScores: results.slice(0, 5).map(r => Number(r.score?.toFixed?.(3) ?? r.score)),
    });

    return results
      .filter(r => r.score >= threshold)
      .map(r => ({ _id: String(r._id), score: r.score }));
  } catch (err) {
    logger.warn('Vector search failed — degraded mode (no vector results)', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Runs Atlas $search (BM25), returns ranked chunk _ids with keyword scores.
 * Returns [] (not a throw) if the index is missing/unavailable.
 */
async function runTextSearch(
  projectId: string,
  queryText: string,
  sourceTypes: string[],
): Promise<Array<{ _id: string; score: number }>> {
  try {
    const results = await ProjectLearningChunk.aggregate([
      {
        $search: {
          index: TEXT_INDEX_NAME,
          compound: {
            must: [
              { text: { query: queryText, path: ['content', 'keyword'] } },
            ],
            filter: [
              { equals: { path: 'projectId', value: new mongoose.Types.ObjectId(projectId) } },
              { in: { path: 'sourceType', value: sourceTypes } },
            ],
          },
        },
      },
      { $limit: HYBRID_TOP_N },
      {
        $project: {
          _id:   1,
          score: { $meta: 'searchScore' },
        },
      },
    ]);

    return results.map(r => ({ _id: String(r._id), score: r.score }));
  } catch (err) {
    logger.warn('Text search failed — degraded mode (no BM25 results)', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Fuses two ranked result lists with Reciprocal Rank Fusion.
 * score(doc) = Σ 1/(rank + RRF_K) across every list the doc appears in,
 * using the doc's 1-based rank in each list. RRF_K=60 is the standard
 * constant (from the original RRF paper) — high enough that no single
 * rank-1 result completely dominates the fused ranking.
 */
function reciprocalRankFusion(
  lists: Array<Array<{ _id: string; score: number }>>,
): Map<string, number> {
  const fused = new Map<string, number>();

  for (const list of lists) {
    list.forEach((item, index) => {
      const rank = index + 1; // 1-based
      const contribution = 1 / (rank + RRF_K);
      fused.set(item._id, (fused.get(item._id) ?? 0) + contribution);
    });
  }

  return fused;
}

/**
 * Core hybrid search: embeds the query, runs vector + BM25 search in
 * parallel, fuses with RRF, applies quality filters (trust level,
 * learning confidence), and returns the top K chunks with full content.
 *
 * projectId is required and non-optional — see multi-tenancy note above.
 */
export async function hybridSearch(options: HybridSearchOptions): Promise<RetrievedChunk[]> {
  const {
    projectId,
    queryText,
    sourceTypes,
    topK,
    excludeLowTrust = true,
    minLearningConfidence = 0.5,
  } = options;

  if (!projectId) {
    throw new Error('hybridSearch: projectId is required — refusing to run an unscoped query');
  }
  if (!queryText || !queryText.trim()) {
    return [];
  }

  let queryVector: number[];
  try {
    queryVector = await embedText(queryText, 'query');
  } catch (err) {
    logger.warn('Query embedding failed — falling back to text-only search', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Degrade to text-search-only rather than failing retrieval entirely.
    const textOnly = await runTextSearch(projectId, queryText, sourceTypes);
    if (textOnly.length === 0) return [];
    return finalizeResults(projectId, reciprocalRankFusion([textOnly]), topK, excludeLowTrust, minLearningConfidence);
  }

  const [vectorResults, textResults] = await Promise.all([
    runVectorSearch(projectId, queryVector, sourceTypes),
    runTextSearch(projectId, queryText, sourceTypes),
  ]);

  if (vectorResults.length === 0 && textResults.length === 0) {
    logger.debug('Hybrid search returned no candidates', { projectId, sourceTypes });
    return [];
  }

  const fused = reciprocalRankFusion([vectorResults, textResults]);
  return finalizeResults(projectId, fused, topK, excludeLowTrust, minLearningConfidence);
}

/**
 * Given fused RRF scores (chunk _id → score), loads full chunk documents,
 * applies quality filters, sorts by fused score, and returns the top K.
 */
async function finalizeResults(
  projectId: string,
  fused: Map<string, number>,
  topK: number,
  excludeLowTrust: boolean,
  minLearningConfidence: number,
): Promise<RetrievedChunk[]> {
  if (fused.size === 0) return [];

  const ids = Array.from(fused.keys());

  const filter: Record<string, unknown> = {
    _id:       { $in: ids.map(id => new mongoose.Types.ObjectId(id)) },
    projectId, // belt-and-suspenders — fused ids already came from a projectId-filtered query
  };

  const docs = await ProjectLearningChunk.find(filter)
    .select('content sourceType sectionTitle classifiedTrustLevel confidence keyword')
    .lean();

  const results: RetrievedChunk[] = docs
    .filter(doc => {
      if (excludeLowTrust && doc.classifiedTrustLevel === 'LOW') return false;
      if (doc.sourceType === 'learning' && typeof doc.confidence === 'number' && doc.confidence < minLearningConfidence) {
        return false;
      }
      return true;
    })
    .map(doc => ({
      _id:                   String(doc._id),
      content:                doc.content,
      sourceType:             doc.sourceType,
      sectionTitle:           doc.sectionTitle,
      classifiedTrustLevel:   doc.classifiedTrustLevel,
      confidence:             doc.confidence,
      keyword:                doc.keyword,
      score:                  fused.get(String(doc._id)) ?? 0,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  logger.debug('Hybrid search finalized', {
    projectId,
    candidateCount: ids.length,
    filteredCount:  results.length,
  });

  return results;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Finds relevant brand-knowledge chunks for a project — the Engine 1 /
 * "personalise with real facts" retrieval described in Section 3 of
 * LEARNING_SYSTEM_ARCHITECTURE.md.
 */
export async function findRelevantKnowledge(
  projectId: string,
  queryText: string,
  topK = 5,
): Promise<RetrievedChunk[]> {
  return hybridSearch({
    projectId,
    queryText,
    sourceTypes: ['knowledge_file'],
    topK,
  });
}

/**
 * Finds relevant past-performance learnings for a project — the Engine 2 /
 * "make new blogs smarter" retrieval described in Section 4.
 * HIGH/MEDIUM confidence only by default (LOW confidence learnings are
 * stored but not applied, per the architecture doc's quality standard).
 */
export async function findRelevantLearnings(
  projectId: string,
  queryText: string,
  topK = 5,
): Promise<RetrievedChunk[]> {
  return hybridSearch({
    projectId,
    queryText,
    sourceTypes: ['learning'],
    topK,
    minLearningConfidence: 0.5, // ~MEDIUM and above on BlogLearning's 0-1 scale
  });
}

/**
 * Formats retrieved chunks for prompt injection, matching the
 * "--- BRAND CONTEXT ---" / "--- PAST LEARNINGS ---" block style from
 * the architecture doc (Sections 3 and 4).
 */
export function formatChunksForPrompt(
  chunks: RetrievedChunk[],
  label: 'BRAND CONTEXT' | 'PAST LEARNINGS FOR THIS KEYWORD CATEGORY',
): string {
  if (chunks.length === 0) return '';

  const body = chunks
    .map(c => {
      const tag = c.sourceType === 'learning'
        ? `Confidence: ${c.confidence !== undefined ? Math.round(c.confidence * 100) + '%' : 'unknown'}`
        : `Source: ${c.sectionTitle ?? c.sourceType}, Trust: ${c.classifiedTrustLevel ?? 'unknown'}`;
      return `[${tag}]\n${c.content}`;
    })
    .join('\n\n');

  return `--- ${label} ---\n${body}\n--- END ${label.split(' ')[0] === 'BRAND' ? 'BRAND CONTEXT' : 'LEARNINGS'} ---`;
}
