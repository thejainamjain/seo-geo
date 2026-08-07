/**
 * lib/knowledge-loader.ts
 *
 * WHAT: Fetches knowledge files from Cloudinary and extracts their text content
 *       into a single string suitable for LLM prompt injection.
 *
 * CONSUMERS:
 *   - content-generation.job.ts → knowledgeChunks param of generateBlogPost()
 *     (deprecated/blog-generation.job.ts also used this before being
 *     superseded — see deprecated/README.md)
 *   - (future) rewrite-engine.job.ts → same pattern
 *
 * WHY THIS EXISTS:
 *   ProjectKnowledgeFile stores a Cloudinary URL + status, but nothing reads
 *   those files and converts them to text. generateBlogPost() takes a
 *   knowledgeChunks: string param that was always receiving empty string.
 *   This fixes that gap.
 *
 * SUPPORTED TYPES:
 *   text/plain       → fetch URL, return text directly
 *   text/markdown    → fetch URL, return text directly
 *   text/csv         → fetch URL, return text (LLM handles CSV natively)
 *   application/json → fetch URL, JSON.stringify with 2-space indent
 *   application/pdf  → fetch URL as ArrayBuffer → extract text via pdf-parse
 *
 * PDF EXTRACTION:
 *   Uses pdf-parse (pure JS, no native deps — works in Node without binaries).
 *   Extracts raw text from PDF — layout is lost but content is preserved.
 *   Good enough for brand guides, pricing docs, FAQs — the typical uploads.
 *
 * CHAR LIMIT PER FILE:
 *   2000 chars per file — prevents one large file from eating the entire
 *   LLM context window. Total knowledgeChunks target: ~6000 chars (3 files).
 *   Files are sorted by classifiedTrustLevel (high first) then createdAt.
 *
 * TOTAL CAP:
 *   8000 chars total — leaves room for SERP analysis and business context
 *   in the blog generation prompt (which is already 12000+ chars of system prompt).
 *
 * ERROR HANDLING:
 *   - File fetch fails → log warn, skip file, continue
 *   - PDF parse fails → log warn, skip file, continue
 *   - Zero files → return empty string (blog still generates, just without knowledge)
 *   Never throws — a blog without knowledge context is better than no blog.
 *
 * CACHING:
 *   No in-memory cache — files change rarely and this runs once per pipeline.
 *   Add Redis caching if knowledge files become a bottleneck.
 */

import { ProjectKnowledgeFile } from '@/models/ProjectKnowledgeFile';
import { logger } from '@/open-tele';

// ── Constants ──────────────────────────────────────────────────────────────

const CHARS_PER_FILE  = 2_000;  // Max chars extracted from any single file
const TOTAL_CHARS_CAP = 8_000;  // Total knowledgeChunks string cap
const FETCH_TIMEOUT   = 20_000; // 20s — Cloudinary is usually fast

// ── PDF text extraction ────────────────────────────────────────────────────

/**
 * Extracts plain text from a PDF buffer using pdf-parse.
 * Returns empty string if extraction fails (non-fatal).
 *
 * pdf-parse is a pure-JS wrapper around pdf.js — no native binaries needed.
 * Install: npm install pdf-parse @types/pdf-parse
 */
async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  try {
    // Dynamic import — pdf-parse has a side effect on load that can fail
    // in some environments if imported at module level.
    // Handle both CJS default and named export shapes across pdf-parse versions.
    const pdfModule = await import('pdf-parse');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfParse  = (pdfModule as any).default ?? pdfModule;
    const data     = await (pdfParse as (buf: Buffer) => Promise<{ text: string }>)(Buffer.from(buffer));
    return data.text ?? '';
  } catch (err) {
    logger.warn('PDF text extraction failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
}

// ── Single file text extractor ─────────────────────────────────────────────

/**
 * Fetches a knowledge file from its Cloudinary URL and returns text content.
 * Returns null if the file cannot be fetched or parsed.
 */
async function extractFileText(
  storageUrl: string,
  mimeType:   string,
  fileId:     string,
  projectId:  string,
): Promise<string | null> {
  let response: Response;

  try {
    response = await fetch(storageUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: {
        // Some CDNs need this header to serve the raw file
        'Accept': '*/*',
      },
    });

    if (!response.ok) {
      logger.warn('Knowledge file fetch returned non-OK status', {
        projectId,
        fileId,
        status: response.status,
        storageUrl,
      });
      return null;
    }
  } catch (err) {
    logger.warn('Knowledge file fetch failed', {
      projectId,
      fileId,
      storageUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  try {
    switch (mimeType) {
      case 'application/pdf': {
        const buffer = await response.arrayBuffer();
        const text   = await extractPdfText(buffer);
        return text.trim() || null;
      }

      case 'application/json': {
        const json = await response.json() as unknown;
        // Pretty-print so LLM can read structure
        return JSON.stringify(json, null, 2);
      }

      case 'text/plain':
      case 'text/markdown':
      case 'text/csv':
      default: {
        const text = await response.text();
        return text.trim() || null;
      }
    }
  } catch (err) {
    logger.warn('Knowledge file content extraction failed', {
      projectId,
      fileId,
      mimeType,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Loads all ready knowledge files for a project and returns a single
 * concatenated string suitable for injection into an LLM prompt.
 *
 * Format of returned string:
 *
 *   === brand_guide: Brand Guidelines.pdf ===
 *   [extracted text, capped at 2000 chars]
 *
 *   === product_sheet: Pricing 2024.pdf ===
 *   [extracted text, capped at 2000 chars]
 *
 * Total output capped at TOTAL_CHARS_CAP (8000 chars).
 *
 * Returns empty string if no files or all fail — blog generation continues.
 */
export async function loadKnowledgeChunks(projectId: string): Promise<string> {
  // 1. Fetch all ready knowledge files, sorted by trust level then date
  const files = await ProjectKnowledgeFile.find({
    projectId,
    status: 'ready',
  })
    .sort({
      // High trust first — brand guidelines > random uploads
      classifiedTrustLevel: -1,
      createdAt:            1,
    })
    .lean();

  if (files.length === 0) {
    logger.debug('No ready knowledge files found for project', { projectId });
    return '';
  }

  logger.info('Knowledge files found for blog generation', {
    projectId,
    count:     files.length,
    fileNames: files.map(f => f.originalName),
  });

  // 2. Extract text from each file, accumulate up to TOTAL_CHARS_CAP
  const chunks: string[] = [];
  let totalChars = 0;

  for (const file of files) {
    if (totalChars >= TOTAL_CHARS_CAP) break;

    const fileId = String(file._id);

    logger.debug('Extracting knowledge file text', {
      projectId,
      fileId,
      name:     file.originalName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
    });

    const rawText = await extractFileText(
      file.storageUrl,
      file.mimeType,
      fileId,
      projectId,
    );

    if (!rawText) {
      logger.warn('Knowledge file yielded no text', {
        projectId,
        fileId,
        name: file.originalName,
      });
      continue;
    }

    // Cap per-file extraction
    const truncated = rawText.slice(0, CHARS_PER_FILE);

    // Label with document kind if classified, otherwise use filename
    const label = file.classifiedDocumentKind
      ? `${file.classifiedDocumentKind}: ${file.originalName}`
      : file.originalName;

    const chunk = `=== ${label} ===\n${truncated}`;
    chunks.push(chunk);
    totalChars += chunk.length;

    logger.debug('Knowledge chunk extracted', {
      projectId,
      fileId,
      name:       file.originalName,
      chars:      truncated.length,
      totalChars,
    });
  }

  if (chunks.length === 0) {
    logger.warn('All knowledge files failed to extract text', { projectId });
    return '';
  }

  const result = chunks.join('\n\n').slice(0, TOTAL_CHARS_CAP);

  logger.info('Knowledge chunks assembled', {
    projectId,
    filesUsed:  chunks.length,
    totalFiles: files.length,
    totalChars: result.length,
  });

  return result;
}

/**
 * Returns true if the project has at least one ready knowledge file.
 * Cheap check — used to decide whether to include knowledge context header
 * in the blog prompt.
 */
export async function hasKnowledgeFiles(projectId: string): Promise<boolean> {
  const count = await ProjectKnowledgeFile.countDocuments({
    projectId,
    status: 'ready',
  });
  return count > 0;
}
