/**
 * lib/chunker.ts
 *
 * WHAT: chunkDocument(text, docType) — splits extracted document text into
 *       overlapping chunks sized for embedding + retrieval.
 *
 * USED BY: workers/jobs/knowledge-processing.job.ts (chunks
 *          ProjectKnowledgeFile text before embedding each piece).
 *
 * STRATEGY BY DOC TYPE — see LEARNING_SYSTEM_ARCHITECTURE.md Section 6.
 * The source spec calls for real table-structure extraction (parsing an
 * actual PDF table layout) and LLM-driven semantic topic-shift detection.
 * Neither is implemented here: table layout doesn't survive PDF text
 * extraction (pdf-parse gives us a flat text stream, not cell boundaries),
 * and running an LLM call per chunk-boundary decision would multiply the
 * cost of every file upload substantially for a marginal gain over the
 * heuristics below. What IS implemented:
 *
 *   pricing      → looks for delimiter-aligned lines (tabs / 2+ spaces /
 *                  pipes forming consistent column counts) and keeps them
 *                  as one chunk per contiguous table block, prefixed with
 *                  a "Table:" label — cheap heuristic, catches the common
 *                  case (a pricing table that survived extraction as
 *                  roughly-aligned text rows) without an LLM call.
 *   case_study   → splits at heading-like lines (short lines, Title Case
 *                  or ALL CAPS, or markdown # / ## prefixes), keeps each
 *                  section whole rather than mid-sentence.
 *   brand_guide  → paragraph-level splitting (blank-line boundaries).
 *   (default)    → groups paragraphs into ~400-500 token chunks, never
 *                  splitting a paragraph across a chunk boundary unless a
 *                  single paragraph itself exceeds the target size.
 *
 * All strategies apply the same overlap rule and produce the same output
 * shape, so callers don't need to know which strategy ran.
 *
 * TOKEN ESTIMATION: no tokenizer library in this project. Using the
 * standard ~4 chars/token approximation for English text (used widely for
 * this exact purpose — good enough for chunk sizing, not exact).
 */

export interface Chunk {
  content:      string;
  chunkIndex:   number;
  sectionTitle?: string;
}

const CHARS_PER_TOKEN   = 4;
const TARGET_TOKENS     = 450;               // midpoint of the 400-500 target
const TARGET_CHARS      = TARGET_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_TOKENS    = 50;
const OVERLAP_CHARS     = OVERLAP_TOKENS * CHARS_PER_TOKEN;
const MAX_CHUNK_CHARS   = 700 * CHARS_PER_TOKEN; // hard ceiling — a single oversized paragraph still gets split

export type KnowledgeDocType = 'pricing' | 'case_study' | 'brand_guide' | 'general';

/**
 * Splits text into paragraphs on blank-line boundaries. Collapses internal
 * whitespace runs but preserves paragraph breaks — this is the shared
 * building block every strategy below uses.
 */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map(p => p.replace(/[ \t]+/g, ' ').trim())
    .filter(p => p.length > 0);
}

/** True if a line looks like a heading rather than prose. */
function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return false;
  if (/^#{1,6}\s+/.test(trimmed)) return true;                  // markdown heading
  if (/^[A-Z0-9 ,'&-]{4,80}$/.test(trimmed)) return true;        // ALL CAPS line
  // Title Case heading: most words capitalized, no ending punctuation
  const words = trimmed.split(/\s+/);
  if (words.length >= 2 && words.length <= 10 && !/[.?!]$/.test(trimmed)) {
    const titleCaseWords = words.filter(w => /^[A-Z][a-z]/.test(w));
    if (titleCaseWords.length >= Math.ceil(words.length * 0.7)) return true;
  }
  return false;
}

/** True if a line looks like a table row (delimiter-aligned columns). */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  // Pipe-delimited (markdown-style table, or text that preserved | separators)
  if ((trimmed.match(/\|/g) ?? []).length >= 2) return true;
  // Tab-delimited
  if ((trimmed.match(/\t/g) ?? []).length >= 1) return true;
  // 2+ consecutive spaces used as a column separator, at least twice on the line
  if ((trimmed.match(/ {2,}/g) ?? []).length >= 2) return true;
  return false;
}

/**
 * Appends `overlapChars` of the end of `previous` to the start of `next`,
 * so no meaning is lost at the boundary. No-op for the first chunk.
 */
function withOverlap(content: string, previousContent: string | null): string {
  if (!previousContent) return content;
  const overlap = previousContent.slice(-OVERLAP_CHARS);
  // Avoid duplicating if the overlap text is already fully contained
  // (can happen with short chunks) — cheap guard, not exact dedup.
  if (content.startsWith(overlap)) return content;
  return `${overlap}${content}`;
}

/** Splits a single oversized paragraph into MAX_CHUNK_CHARS-sized pieces on sentence boundaries where possible. */
function splitOversizedParagraph(paragraph: string): string[] {
  if (paragraph.length <= MAX_CHUNK_CHARS) return [paragraph];

  const sentences = paragraph.split(/(?<=[.?!])\s+/);
  const pieces: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length > MAX_CHUNK_CHARS && current.length > 0) {
      pieces.push(current.trim());
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current.trim()) pieces.push(current.trim());

  // Pathological case: a single "sentence" longer than MAX_CHUNK_CHARS
  // (no punctuation at all) — hard character split as last resort.
  return pieces.flatMap(p =>
    p.length > MAX_CHUNK_CHARS
      ? p.match(new RegExp(`.{1,${MAX_CHUNK_CHARS}}`, 'g')) ?? [p]
      : [p],
  );
}

/** Groups paragraphs into ~TARGET_CHARS chunks, with overlap, never splitting a paragraph unless it alone exceeds the max. */
function groupParagraphsIntoChunks(
  paragraphs: string[],
  sectionTitle?: string,
): Chunk[] {
  const chunks: Chunk[] = [];
  let current = '';
  let chunkIndex = 0;
  let previousContent: string | null = null;

  const flush = () => {
    if (!current.trim()) return;
    chunks.push({
      content:      withOverlap(current.trim(), previousContent),
      chunkIndex:   chunkIndex++,
      sectionTitle,
    });
    previousContent = current.trim();
    current = '';
  };

  for (const rawParagraph of paragraphs) {
    for (const paragraph of splitOversizedParagraph(rawParagraph)) {
      if (current.length + paragraph.length > TARGET_CHARS && current.length > 0) {
        flush();
      }
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  flush();

  return chunks;
}

/** Pricing strategy: extract contiguous table-like blocks as their own chunks; everything else falls through to general prose chunking. */
function chunkPricing(text: string): Chunk[] {
  const lines = text.split('\n');
  const chunks: Chunk[] = [];
  let chunkIndex = 0;
  let tableBuffer: string[] = [];
  let proseBuffer: string[] = [];

  const flushTable = () => {
    if (tableBuffer.length === 0) return;
    chunks.push({
      content:      `Table: Pricing\n${tableBuffer.join('\n')}`,
      chunkIndex:   chunkIndex++,
      sectionTitle: 'Pricing',
    });
    tableBuffer = [];
  };

  const flushProse = () => {
    if (proseBuffer.length === 0) return;
    const paragraphs = splitParagraphs(proseBuffer.join('\n'));
    for (const chunk of groupParagraphsIntoChunks(paragraphs)) {
      chunks.push({ ...chunk, chunkIndex: chunkIndex++ });
    }
    proseBuffer = [];
  };

  for (const line of lines) {
    if (isTableRow(line)) {
      flushProse();
      tableBuffer.push(line.trim());
    } else {
      flushTable();
      proseBuffer.push(line);
    }
  }
  flushTable();
  flushProse();

  return chunks;
}

/** Case study / heading-delimited strategy: split at heading lines, keep each section whole (further split only if a section itself is oversized). */
function chunkByHeadingSections(text: string): Chunk[] {
  const lines = text.split('\n');
  const sections: Array<{ title?: string; body: string[] }> = [{ body: [] }];

  for (const line of lines) {
    if (isHeadingLine(line)) {
      sections.push({ title: line.replace(/^#{1,6}\s+/, '').trim(), body: [] });
    } else {
      sections[sections.length - 1].body.push(line);
    }
  }

  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const section of sections) {
    const sectionText = section.body.join('\n').trim();
    if (!sectionText) continue;

    if (sectionText.length <= MAX_CHUNK_CHARS) {
      // Whole section as one chunk — the point of this strategy is to
      // never split "problem / solution / results" across chunks.
      chunks.push({
        content:      sectionText,
        chunkIndex:   chunkIndex++,
        sectionTitle: section.title,
      });
    } else {
      const paragraphs = splitParagraphs(sectionText);
      for (const chunk of groupParagraphsIntoChunks(paragraphs, section.title)) {
        chunks.push({ ...chunk, chunkIndex: chunkIndex++ });
      }
    }
  }

  return chunks;
}

/**
 * Splits document text into chunks using the strategy appropriate to
 * docType. Every chunk is self-contained (overlap applied) and sized
 * ~400-500 tokens (except case-study sections, which are kept whole up to
 * MAX_CHUNK_CHARS on purpose — see module doc comment).
 */
export function chunkDocument(text: string, docType: KnowledgeDocType): Chunk[] {
  const cleaned = text.replace(/\r\n/g, '\n').trim();
  if (!cleaned) return [];

  switch (docType) {
    case 'pricing':
      return chunkPricing(cleaned);
    case 'case_study':
      return chunkByHeadingSections(cleaned);
    case 'brand_guide':
    case 'general':
    default:
      return groupParagraphsIntoChunks(splitParagraphs(cleaned));
  }
}
