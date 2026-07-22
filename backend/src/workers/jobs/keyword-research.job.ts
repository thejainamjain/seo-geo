/**
 * workers/jobs/keyword-research.job.ts
 *
 * WHAT: Discovers, scores, and schedules keywords for blog content generation.
 *
 * PIPELINE POSITION: Step 5 of 8
 * READS:  BusinessContext (competitors, product description, target regions)
 *         Project (domain, creation date for week scheduling)
 * WRITES: Keyword documents (up to 260, status: 'upcoming')
 *
 * KEYWORD DISCOVERY PIPELINE (3 sources, combined and deduplicated):
 *
 *   Source 1 — LLM Market Sizing (1 call):
 *     generateMarketSizing() → 20 seed keywords with estimated volume + difficulty.
 *     Fast, free, always runs first. Gives us keywords even if DataForSEO fails.
 *
 *   Source 2 — DataForSEO Competitor Keywords:
 *     For each competitor domain from BusinessContext.competition.mainCompetitors,
 *     fetch up to 50 keywords they rank for (position ≤ 30, volume > 0).
 *     10 competitors × 50 keywords = up to 500 raw keywords.
 *     Competitors processed sequentially to respect DataForSEO rate limits.
 *
 *   Source 3 — (future) GSC Import — not in this job, done separately.
 *
 * DEDUPLICATION:
 *   Keywords are deduplicated by normalised keyword string across all sources.
 *   Normalisation: lowercase, trim, collapse whitespace.
 *   DataForSEO data wins over LLM estimates when the same keyword appears
 *   in both sources (real data > estimated data).
 *
 * ALIGNMENT SCORING:
 *   After deduplication, batch-score all keywords via LLM (50 per batch).
 *   scoreKeywordAlignment() returns alignmentScore (0–100) + relevanceReason.
 *   Keywords scoring < MIN_ALIGNMENT_SCORE are dropped.
 *
 * KEYWORD SELECTION:
 *   After scoring, keep top 260 keywords sorted by:
 *     alignmentScore desc → searchVolume desc → difficulty asc
 *   This matches RankAI's content calendar approach (5/week × 52 weeks).
 *
 * WEEK SCHEDULING:
 *   5 keywords per week. weekNumber = Math.ceil((index + 1) / 5).
 *   startDate = project.createdAt + (weekNumber - 1) × 7 days.
 *   This populates the "Keywords & Content" calendar view in the UI.
 *
 * IDEMPOTENCY:
 *   Uses bulkWrite with upsert:true keyed on { projectId, keyword }.
 *   Safe to retry — existing keywords are updated, not duplicated.
 *   alignmentScore and weekNumber are always refreshed on retry.
 *
 * ERROR HANDLING:
 *   - BusinessContext missing → throws → BullMQ retries
 *   - DataForSEO fails for one competitor → logged, skip to next competitor
 *     (partial keyword list is better than no keywords)
 *   - LLM alignment scoring fails for one batch → logged, keywords kept
 *     with alignmentScore: 0 (will be at the bottom of the list)
 *   - Zero keywords after all sources → throws → BullMQ retries
 *     (cannot generate blogs without keywords)
 */

import type { Job } from 'bullmq';
import { Types } from 'mongoose';
import { logger }          from '@/open-tele';
import { Project, Keyword, BusinessContext}         from '@/models';
import type { CompetitorEntry }          from '@/models/BusinessContext';
import { getRankedKeywords } from '@/lib/dataforseo';
import { generateMarketSizing, scoreKeywordAlignment } from '@/lib/llm';
import { deriveCountryCodeFromRegions } from '@/lib/serp';
import type { PipelineJobData }          from '../seo-pipeline.worker';
import type { DataForSeoKeyword }        from '@/lib/dataforseo';
import { LLM_RATE_LIMIT }               from '@/constants/seo-pipeline.constants';

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_KEYWORDS_TOTAL    = 260;  // 5/week × 52 weeks
const KEYWORDS_PER_WEEK     = 5;
const ALIGNMENT_BATCH_SIZE  = 50;   // Keywords per LLM scoring call
const MIN_ALIGNMENT_SCORE   = 20;   // Drop keywords below this threshold
const MAX_KEYWORDS_PER_COMP = 50;   // DataForSEO cap per competitor domain
const MS_PER_WEEK           = 7 * 24 * 60 * 60 * 1000;

// ── Types ──────────────────────────────────────────────────────────────────

interface RawKeyword {
  keyword:      string;
  searchVolume: number;
  difficulty:   number;
  cpc:          number;
  source:       'ai_suggested' | 'dataforseo';
}

interface ScoredKeyword extends RawKeyword {
  alignmentScore:  number;
  relevanceReason: string;
}

// ── Keyword normalisation ──────────────────────────────────────────────────

/**
 * Normalises a keyword string for deduplication.
 * Lowercase + trim + collapse whitespace.
 * "Floor Cleaning  Products" → "floor cleaning products"
 */
function normaliseKeyword(kw: string): string {
  return kw.toLowerCase().trim().replace(/\s+/g, ' ');
}

// ── Source 1: LLM Market Sizing ────────────────────────────────────────────

/**
 * Generates 20 seed keywords via LLM market sizing.
 * Always runs first — provides baseline even if DataForSEO fails.
 */
async function fetchMarketSizingKeywords(
  businessDescription: string,
  countryCode:         string,
  projectId:           string,
): Promise<RawKeyword[]> {
  logger.info('Fetching market sizing keywords from LLM', { projectId });

  try {
    const result = await generateMarketSizing(
      businessDescription,
      countryCode,
      projectId,
    );

    const keywords: RawKeyword[] = result.keywords.map(k => ({
      keyword:      k.keyword,
      searchVolume: k.search_volume,
      difficulty:   k.difficulty,
      cpc:          0, // LLM doesn't estimate CPC
      source:       'ai_suggested' as const,
    }));

    logger.info('Market sizing keywords fetched', {
      projectId,
      count: keywords.length,
      topKeywords: keywords.slice(0, 5).map(k => k.keyword),
    });

    return keywords;

  } catch (err) {
    // Non-fatal — log and continue with DataForSEO only
    logger.error(
      err instanceof Error ? err : new Error(String(err)),
      { projectId, context: 'keyword-research.market-sizing' },
    );
    return [];
  }
}

// ── Source 2: DataForSEO Competitor Keywords ───────────────────────────────

/**
 * Fetches keywords from DataForSEO for each competitor domain.
 * Processes competitors sequentially — DataForSEO is billed per call.
 * Skips failed competitors — partial data is better than no data.
 */
async function fetchCompetitorKeywords(
  competitors: string[],
  countryCode: string,
  projectId:   string,
): Promise<RawKeyword[]> {
  if (competitors.length === 0) {
    logger.warn('No competitors to fetch keywords for', { projectId });
    return [];
  }

  logger.info('Fetching competitor keywords from DataForSEO', {
    projectId,
    competitorCount: competitors.length,
    competitors,
  });

  const allKeywords: RawKeyword[] = [];

  for (let i = 0; i < competitors.length; i++) {
    const domain = competitors[i]!;

    try {
      const result = await getRankedKeywords(
        domain,
        countryCode,
        projectId,
        MAX_KEYWORDS_PER_COMP,
      );

      const mapped: RawKeyword[] = result.keywords.map((k: DataForSeoKeyword) => ({
        keyword:      k.keyword,
        searchVolume: k.searchVolume,
        difficulty:   k.difficulty,
        cpc:          k.cpc,
        source:       'dataforseo' as const,
      }));

      allKeywords.push(...mapped);

      logger.debug('Competitor keywords fetched', {
        projectId,
        domain,
        count: mapped.length,
        competitorIndex: i + 1,
        totalCompetitors: competitors.length,
      });

    } catch (err) {
      // Skip this competitor — continue to next
      logger.error(
        err instanceof Error ? err : new Error(String(err)),
        {
          projectId,
          domain,
          competitorIndex: i + 1,
          context: 'keyword-research.competitor-fetch',
        },
      );
    }
  }

  logger.info('All competitor keywords fetched', {
    projectId,
    totalRaw: allKeywords.length,
  });

  return allKeywords;
}

// ── Deduplication ──────────────────────────────────────────────────────────

/**
 * Deduplicates keywords across sources.
 * DataForSEO data wins over LLM estimates for the same keyword
 * (real search volume > LLM estimate).
 *
 * Returns a map of normalised keyword → best RawKeyword.
 */
function deduplicateKeywords(
  llmKeywords:        RawKeyword[],
  competitorKeywords: RawKeyword[],
  projectId:          string,
): RawKeyword[] {
  const seen = new Map<string, RawKeyword>();

  // LLM keywords go in first (lower priority)
  for (const kw of llmKeywords) {
    const norm = normaliseKeyword(kw.keyword);
    if (norm.length < 3) continue; // skip noise
    seen.set(norm, { ...kw, keyword: norm });
  }

  // DataForSEO keywords overwrite LLM estimates (higher priority)
  for (const kw of competitorKeywords) {
    const norm = normaliseKeyword(kw.keyword);
    if (norm.length < 3) continue;
    seen.set(norm, { ...kw, keyword: norm }); // overwrites LLM entry
  }

  const deduped = Array.from(seen.values());

  logger.info('Keywords deduplicated', {
    projectId,
    llmCount:        llmKeywords.length,
    competitorCount: competitorKeywords.length,
    afterDedup:      deduped.length,
  });

  return deduped;
}

// ── Alignment scoring ──────────────────────────────────────────────────────

/**
 * Scores all keywords for alignment to the business in batches.
 * Uses ALIGNMENT_BATCH_SIZE keywords per LLM call to keep prompts focused.
 * Failed batches get alignmentScore: 0 — sorted to bottom, not dropped.
 */
async function scoreKeywords(
  keywords:            RawKeyword[],
  businessDescription: string,
  projectId:           string,
): Promise<ScoredKeyword[]> {
  logger.info('Starting keyword alignment scoring', {
    projectId,
    keywordCount: keywords.length,
    batchSize:    ALIGNMENT_BATCH_SIZE,
    batchCount:   Math.ceil(keywords.length / ALIGNMENT_BATCH_SIZE),
  });

  const scored: ScoredKeyword[] = [];

  for (let i = 0; i < keywords.length; i += ALIGNMENT_BATCH_SIZE) {
    const batch     = keywords.slice(i, i + ALIGNMENT_BATCH_SIZE);
    const batchNum  = Math.floor(i / ALIGNMENT_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(keywords.length / ALIGNMENT_BATCH_SIZE);

    logger.debug('Scoring keyword batch', {
      projectId,
      batchNum,
      totalBatches,
      batchSize: batch.length,
    });

    try {
      const keywordList = batch.map(k => k.keyword).join('\n');

      const result = await scoreKeywordAlignment(
        keywordList,
        businessDescription,
        projectId,
      );

      // Map scored results back to our keywords
      // LLM returns keywords in same order — match by normalised keyword string
      const scoreMap = new Map(
        result.keywords.map(k => [normaliseKeyword(k.keyword), k]),
      );

      for (const kw of batch) {
        const norm   = normaliseKeyword(kw.keyword);
        const llmKw  = scoreMap.get(norm);

        scored.push({
          ...kw,
          alignmentScore:  llmKw?.alignmentScore  ?? 0,
          relevanceReason: llmKw?.reasoning        ?? '',
        });
      }

      logger.debug('Keyword batch scored', {
        projectId,
        batchNum,
        totalBatches,
        scored: result.keywords.length,
      });

    } catch (err) {
      // Scoring failed for this batch — add keywords with score 0
      logger.error(
        err instanceof Error ? err : new Error(String(err)),
        {
          projectId,
          batchNum,
          totalBatches,
          context: 'keyword-research.alignment-scoring',
        },
      );

      for (const kw of batch) {
        scored.push({ ...kw, alignmentScore: 0, relevanceReason: '' });
      }
    }

    // Rate limit delay between LLM batches (skip after last batch)
    if (i + ALIGNMENT_BATCH_SIZE < keywords.length) {
      await new Promise(resolve => setTimeout(resolve, LLM_RATE_LIMIT.DELAY_MS));
    }
  }

  return scored;
}

// ── Selection + sorting ────────────────────────────────────────────────────

/**
 * Filters, sorts, and caps the keyword list.
 * Sort: alignmentScore desc → searchVolume desc → difficulty asc
 * Filter: drop keywords below MIN_ALIGNMENT_SCORE
 * Cap: keep top MAX_KEYWORDS_TOTAL
 */
function selectTopKeywords(
  keywords:  ScoredKeyword[],
  projectId: string,
): ScoredKeyword[] {
  const beforeFilter = keywords.length;

  const filtered = keywords.filter(k => k.alignmentScore >= MIN_ALIGNMENT_SCORE);

  const sorted = filtered.sort((a, b) => {
    if (b.alignmentScore !== a.alignmentScore) return b.alignmentScore - a.alignmentScore;
    if (b.searchVolume   !== a.searchVolume)   return b.searchVolume   - a.searchVolume;
    return a.difficulty - b.difficulty; // lower difficulty = better
  });

  const selected = sorted.slice(0, MAX_KEYWORDS_TOTAL);

  logger.info('Keywords selected for content calendar', {
    projectId,
    beforeFilter,
    afterFilter:    filtered.length,
    afterCap:       selected.length,
    minScore:       MIN_ALIGNMENT_SCORE,
    cap:            MAX_KEYWORDS_TOTAL,
    topKeywords:    selected.slice(0, 10).map(k => ({
      keyword:        k.keyword,
      alignmentScore: k.alignmentScore,
      searchVolume:   k.searchVolume,
    })),
  });

  return selected;
}

// ── Week scheduling ────────────────────────────────────────────────────────

/**
 * Assigns weekNumber and startDate to each keyword.
 * weekNumber = Math.ceil((index + 1) / KEYWORDS_PER_WEEK)
 * startDate  = project.createdAt + (weekNumber - 1) × 7 days
 *
 * This populates the content calendar shown in the UI
 * (Week 1, Week 2, etc. with dates).
 */
function assignWeekNumbers(
  keywords:        ScoredKeyword[],
  projectCreatedAt: Date,
): Array<ScoredKeyword & { weekNumber: number; startDate: Date }> {
  return keywords.map((kw, index) => {
    const weekNumber = Math.ceil((index + 1) / KEYWORDS_PER_WEEK);
    const startDate  = new Date(projectCreatedAt.getTime() + (weekNumber - 1) * MS_PER_WEEK);
    return { ...kw, weekNumber, startDate };
  });
}

// ── Main job handler ───────────────────────────────────────────────────────

export async function runKeywordResearchJob(job: Job<PipelineJobData>): Promise<void> {
  const { projectId } = job.data;

  logger.info('Keyword research job started', { projectId, jobId: job.id });

  // 1. Load project — need createdAt for week scheduling
  const project = await Project.findById(projectId).lean();
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }
  const projectObjectId = new Types.ObjectId(projectId);

  // 2. Load BusinessContext — need competitors + business description
  const bc = await BusinessContext.findOne({ projectId }).lean();
  if (!bc) {
    throw new Error(
      `BusinessContext not found for project ${projectId}. ` +
      `Ensure BUSINESS_PROFILE step completed successfully.`
    );
  }

  // Only use VERIFIED competitor entries for keyword research — an
  // unverified user/AI-drafted domain hasn't been confirmed as a real
  // competitor yet, and burning DataForSEO calls on it would waste quota
  // on potentially-wrong data. See docs/05-phase4-competitor-discovery-audit.md.
  const competitorEntries = (bc.competition?.mainCompetitors as CompetitorEntry[] | undefined) ?? [];
  const competitors = competitorEntries.filter(c => c.verified).map(c => c.domain);
  const countryCode = deriveCountryCodeFromRegions(
    bc.company?.targetRegions as string[] | undefined,
    projectId,
  );

  // Build business description for LLM calls
  // Combine the most signal-rich fields into one string
  const businessDescription = [
    bc.product?.whatItSells,
    bc.customers?.topUseCases,
    bc.customers?.keywordsTheyUse,
    bc.competition?.differentiation,
  ].filter(Boolean).join('\n');

  logger.info('Keyword research context loaded', {
    projectId,
    domain:              project.domain,
    competitorCount:     competitors.length,
    countryCode,
    descriptionLength:   businessDescription.length,
  });

  // 3. Source 1 — LLM market sizing (20 seed keywords)
  const llmKeywords = await fetchMarketSizingKeywords(
    businessDescription,
    countryCode,
    projectId,
  );

  // Rate limit delay before DataForSEO calls
  if (llmKeywords.length > 0 && competitors.length > 0) {
    await new Promise(resolve => setTimeout(resolve, LLM_RATE_LIMIT.DELAY_MS));
  }

  // 4. Source 2 — DataForSEO competitor keywords
  const competitorKeywords = await fetchCompetitorKeywords(
    competitors,
    countryCode,
    projectId,
  );

  // 5. Deduplicate across sources
  const deduped = deduplicateKeywords(llmKeywords, competitorKeywords, projectId);

  if (deduped.length === 0) {
    throw new Error(
      `Zero keywords discovered for project ${projectId}. ` +
      `Both LLM market sizing and DataForSEO returned empty results. ` +
      `Check DATAFORSEO credentials and BusinessContext.`
    );
  }

  // 6. Score all keywords for alignment to the business
  const scored = await scoreKeywords(deduped, businessDescription, projectId);

  // 7. Select top keywords, filter low-alignment, sort
  const selected = selectTopKeywords(scored, projectId);

  if (selected.length === 0) {
    throw new Error(
      `All ${deduped.length} keywords scored below minimum alignment threshold ` +
      `(${MIN_ALIGNMENT_SCORE}). BusinessContext may be incomplete. ` +
      `Project: ${projectId}`
    );
  }

  // 8. Assign week numbers + start dates
  const scheduled = assignWeekNumbers(selected, project.createdAt as Date);

  logger.info('Keywords scheduled for content calendar', {
    projectId,
    total:     scheduled.length,
    weeks:     Math.ceil(scheduled.length / KEYWORDS_PER_WEEK),
    weekRange: `Week 1 to Week ${Math.ceil(scheduled.length / KEYWORDS_PER_WEEK)}`,
  });

  // 9. Upsert all keywords — idempotent, safe on retry
  //    bulkWrite with upsert:true keyed on { projectId, keyword }
  const bulkOps = scheduled.map(kw => ({
    updateOne: {
      filter: { projectId: projectObjectId, keyword: kw.keyword },
      update: {
        $set: {
          searchVolume:    kw.searchVolume,
          difficulty:      kw.difficulty,
          cpc:             kw.cpc,
          status:          'upcoming' as const,
          source:          kw.source,
          alignmentScore:  kw.alignmentScore,
          relevanceReason: kw.relevanceReason,
          weekNumber:      kw.weekNumber,
          startDate:       kw.startDate,
          pageType:        'blog' as const,
        },
        $setOnInsert: {
          projectId: projectObjectId,
          keyword: kw.keyword,
        },
      },
      upsert: true,
    },
  }));

  const bulkResult = await Keyword.bulkWrite(bulkOps, { ordered: false }); 
  logger.info('Keywords upserted to database', {                            
    projectId,
    upserted:  bulkResult.upsertedCount,
    modified:  bulkResult.modifiedCount,
    total:     scheduled.length,
  });

  logger.info('Keyword research job completed', {
    projectId,
    jobId:          job.id,
    keywordsTotal:  scheduled.length,
    weeksScheduled: Math.ceil(scheduled.length / KEYWORDS_PER_WEEK),
    topKeyword:     scheduled[0]?.keyword,
    topScore:       scheduled[0]?.alignmentScore,
  });
}
