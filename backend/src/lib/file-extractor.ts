/**
 * lib/file-extractor.ts
 *
 * WHAT: extractText(storageUrl, mimeType, fileId, projectId) — fetches a
 *       knowledge file from its Cloudinary URL and returns its raw text.
 *
 * WHY THIS EXISTS AS ITS OWN FILE: this logic used to live as private
 * functions inside lib/knowledge-loader.ts. Extracted here so the new
 * chunking pipeline (workers/jobs/knowledge-processing.job.ts) and the
 * older whole-file loader (lib/knowledge-loader.ts, still used as a
 * degraded-mode fallback when no chunks/embeddings exist yet for a
 * project) share one extraction implementation instead of two.
 *
 * SUPPORTED TYPES: same as knowledge.service.ts's ALLOWED_MIMES —
 *   text/plain, text/markdown, text/csv → fetch + return as-is
 *   application/json                    → fetch + pretty-print
 *   application/pdf                     → fetch as ArrayBuffer, pdf-parse
 *
 * DOCX is NOT supported yet (not in ALLOWED_MIMES either) — flagged as a
 * follow-up, out of scope for this pass.
 *
 * ERROR HANDLING: never throws — returns null on any failure (fetch error,
 * non-OK status, parse failure). Callers decide what a null extraction
 * means for them.
 */

import { logger } from '../open-tele';

const FETCH_TIMEOUT = 20_000; // 20s — Cloudinary is usually fast

/**
 * Extracts plain text from a PDF buffer using pdf-parse.
 * Returns empty string if extraction fails (non-fatal).
 */
async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  try {
    // Dynamic import — pdf-parse has a side effect on load that can fail
    // in some environments if imported at module level.
    const pdfModule = await import('pdf-parse');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfParse  = (pdfModule as any).default ?? pdfModule;
    const data      = await (pdfParse as (buf: Buffer) => Promise<{ text: string }>)(Buffer.from(buffer));
    return data.text ?? '';
  } catch (err) {
    logger.warn('PDF text extraction failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
}

/**
 * Fetches a knowledge file from its storage URL and returns its extracted
 * text content, or null if the file cannot be fetched or parsed.
 */
export async function extractText(
  storageUrl: string,
  mimeType:   string,
  fileId:     string,
  projectId:  string,
): Promise<string | null> {
  let response: Response;

  try {
    response = await fetch(storageUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: { 'Accept': '*/*' }, // some CDNs need this to serve the raw file
    });

    if (!response.ok) {
      logger.warn('Knowledge file fetch returned non-OK status', {
        projectId, fileId, status: response.status, storageUrl,
      });
      return null;
    }
  } catch (err) {
    logger.warn('Knowledge file fetch failed', {
      projectId, fileId, storageUrl,
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
        return JSON.stringify(json, null, 2); // pretty-print so downstream chunking/LLM can read structure
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
      projectId, fileId, mimeType,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
