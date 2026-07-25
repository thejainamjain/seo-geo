/**
 * WHAT: Processes ONE uploaded knowledge file end-to-end: extract text →
 *       classify the document → chunk it → embed each chunk → store as
 *       ProjectLearningChunk (sourceType: "knowledge_file").
 *
 * WHY THIS FILE EXISTS: ProjectKnowledgeFile records were being created at
 * `status: "pending"` by knowledge.service.ts on upload, but nothing in the
 * codebase ever moved them past that — no job read them, classified them,
 * or chunked them. Files just sat at "pending" forever. This job is that
 * missing piece — see docs/13-knowledge-learning-system.md for the full
 * picture of what this unblocks (real RAG retrieval instead of the
 * whole-file-truncation fallback in lib/knowledge-loader.ts).
 *
 * TRIGGERED BY: knowledge.service.ts's uploadFile(), right after creating
 *               the ProjectKnowledgeFile record.
 * QUEUE:        seo-knowledge-processing
 *
 * READS:
 *   ProjectKnowledgeFile → the file record (storageUrl, mimeType)
 *
 * WRITES:
 *   ProjectKnowledgeFile → status: pending → processing → ready | error,
 *                          classification fields
 *   ProjectLearningChunk → one doc per chunk (sourceType: "knowledge_file")
 *
 * LLM CALLS (2 total, both cheap):
 *   1. classifyKnowledgeFile — once per file, not per chunk (see llm.ts
 *      doc comment on that function for why)
 *   2. embedText — once per chunk (via lib/embeddings.ts, not lib/llm.ts)
 *
 * ERROR HANDLING:
 *   - File not found → log warn, return (nothing to process — likely
 *     deleted between upload and job pickup)
 *   - Extraction fails (unsupported/corrupt file) → status: 'error',
 *     errorMessage set, return (not thrown — a bad upload shouldn't
 *     retry-loop forever burning LLM calls on a file that will never parse)
 *   - Classification fails → log warn, fall back to
 *     classifiedDocumentKind: 'general', classifiedTrustLevel: 'MEDIUM'
 *     (degraded but not fatal — the file still gets chunked and is still
 *     retrievable, just without the finer trust/kind signal)
 *   - Individual chunk embedding fails → log warn, skip that one chunk,
 *     continue with the rest (partial knowledge beats none — same
 *     philosophy as embeddings.ts's own retry logic)
 *   - Zero chunks successfully embedded → status: 'error'
 *
 * IDEMPOTENCY:
 *   Deletes any existing ProjectLearningChunk docs for this fileId before
 *   inserting new ones — safe to retry (BullMQ) or re-run manually without
 *   creating duplicate chunks.
 */

import { logger }                 from '@/open-tele';
import { ProjectKnowledgeFile }   from '@/models/ProjectKnowledgeFile';
import { ProjectLearningChunk }   from '@/models';
import { extractText }            from '@/lib/file-extractor';
import { chunkDocument, type KnowledgeDocType } from '@/lib/chunker';
import { embedTexts }             from '@/lib/embeddings';
import { classifyKnowledgeFile }  from '@/lib/llm';

export interface KnowledgeProcessingJobData {
  projectId: string;
  fileId:    string;
}

const EMBED_BATCH_SIZE = 40; // stay comfortably under Gemini's batchEmbedContents request-count limit (see embeddings.ts)

export async function runKnowledgeProcessingJob(
  data: KnowledgeProcessingJobData,
): Promise<void> {
  const { projectId, fileId } = data;

  logger.info('Knowledge processing job started', { projectId, fileId });

  // ── 1. Load and validate file ────────────────────────────────────────────

  const file = await ProjectKnowledgeFile.findOne({ _id: fileId, projectId });
  if (!file) {
    logger.warn('Knowledge processing skipped — file not found (likely deleted)', {
      projectId, fileId,
    });
    return;
  }

  if (file.status === 'ready') {
    logger.info('Knowledge processing skipped — file already ready', { projectId, fileId });
    return;
  }

  file.status = 'processing';
  await file.save();

  // ── 2. Extract text ──────────────────────────────────────────────────────

  const rawText = await extractText(file.storageUrl, file.mimeType, fileId, projectId);

  if (!rawText) {
    file.status       = 'error';
    file.errorMessage = 'Could not extract text from file — unsupported or corrupt content';
    await file.save();
    logger.warn('Knowledge processing failed — extraction returned no text', {
      projectId, fileId, mimeType: file.mimeType,
    });
    return;
  }

  // ── 3. Classify (once per file) ──────────────────────────────────────────

  let classification;
  try {
    classification = await classifyKnowledgeFile(file.originalName, rawText, projectId, fileId);
  } catch (err) {
    logger.warn('Knowledge file classification failed — using safe defaults', {
      projectId, fileId,
      error: err instanceof Error ? err.message : String(err),
    });
    classification = {
      classifiedDocumentKind:  'general' as const,
      classifiedUsageTags:     [],
      classifiedAudience:      'General' as const,
      classifiedTrustLevel:    'MEDIUM' as const,
      classificationReasoning: 'Classification failed — defaulted to MEDIUM trust pending manual review.',
    };
  }

  file.classifiedDocumentKind  = classification.classifiedDocumentKind;
  file.classifiedUsageTags     = classification.classifiedUsageTags;
  file.classifiedAudience      = classification.classifiedAudience;
  file.classifiedTrustLevel    = classification.classifiedTrustLevel;
  file.classificationReasoning = classification.classificationReasoning;
  file.classifiedAt            = new Date();
  await file.save();

  // ── 4. Chunk ──────────────────────────────────────────────────────────────

  const docType = (['pricing', 'case_study', 'brand_guide', 'general'] as const)
    .includes(classification.classifiedDocumentKind as KnowledgeDocType)
    ? (classification.classifiedDocumentKind as KnowledgeDocType)
    : 'general';

  const chunks = chunkDocument(rawText, docType);

  if (chunks.length === 0) {
    file.status       = 'error';
    file.errorMessage = 'File extracted but produced no usable chunks (likely empty or whitespace-only content)';
    await file.save();
    logger.warn('Knowledge processing failed — zero chunks produced', { projectId, fileId });
    return;
  }

  logger.info('Knowledge file chunked', {
    projectId, fileId, docType, chunkCount: chunks.length,
  });

  // ── 5. Embed each chunk (batched) ────────────────────────────────────────

  const embeddedChunks: Array<{ content: string; sectionTitle?: string; embedding: number[] }> = [];

  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    try {
      const vectors = await embedTexts(batch.map(c => c.content));
      batch.forEach((chunk, idx) => {
        embeddedChunks.push({
          content:      chunk.content,
          sectionTitle: chunk.sectionTitle,
          embedding:    vectors[idx],
        });
      });
    } catch (err) {
      // Whole batch failed (embedTexts already retried internally — see
      // embeddings.ts). Skip this batch, keep whatever succeeded from
      // other batches — partial knowledge beats none.
      logger.warn('Chunk batch embedding failed — skipping batch', {
        projectId, fileId,
        batchStart: i,
        batchSize:  batch.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (embeddedChunks.length === 0) {
    file.status       = 'error';
    file.errorMessage = 'All chunks failed to embed — see logs for embedding errors';
    await file.save();
    logger.error('Knowledge processing failed — zero chunks embedded', { projectId, fileId });
    return;
  }

  // ── 6. Store chunks (idempotent — clear any previous chunks for this file first) ──

  await ProjectLearningChunk.deleteMany({ fileId, projectId });

  await ProjectLearningChunk.insertMany(
    embeddedChunks.map(c => ({
      projectId,
      fileId,
      sourceType:           'knowledge_file' as const,
      content:              c.content,
      embeddingInputText:   c.content,
      embedding:            c.embedding,
      sectionTitle:         c.sectionTitle,
      classifiedTrustLevel: file.classifiedTrustLevel,
    })),
  );

  // ── 7. Done ───────────────────────────────────────────────────────────────

  file.status = 'ready';
  await file.save();

  logger.info('Knowledge processing job completed', {
    projectId, fileId,
    chunksStored:  embeddedChunks.length,
    chunksSkipped: chunks.length - embeddedChunks.length,
    trustLevel:    file.classifiedTrustLevel,
  });
}
