/**
 * workers/jobs/competitor-discovery.job.ts
 *
 * WHAT: Discovers the top real competitors for this project by running
 *       a Google SERP search for the business's core keyword and extracting
 *       the domains that rank for the same searches.
 *
 * PIPELINE POSITION: Step 4 of 8
 * READS:  BusinessContext (for core keyword + target region)
 *         Project (for own domain to exclude)
 * WRITES: BusinessContext.competition.mainCompetitors (array of domains)
 *
 * WHY SERP-BASED (not LLM-guessed):
 *   LLM hallucination risk is high for competitor lists.
 *   Gemini will confidently name competitors that don't exist or
 *   don't actually rank for the same keywords.
 *   SerpAPI gives us ground truth — real domains that Google ranks
 *   for the business's core keyword RIGHT NOW.
 *   This is exactly what RankAI does (visible in their UI screenshots).
 *
 * CORE KEYWORD EXTRACTION:
 *   Priority order (highest signal first):
 *   1. customers.topUseCases    — "what users search to find this business"
 *   2. customers.keywordsTheyUse — keywords LLM extracted from site content
 *   3. product.whatItSells      — product description (noisier)
 *   4. company.description      — general description (noisiest)
 *   5. project.domain           — last resort — domain name as keyword
 *
 *   From whichever field has content, extract the FIRST meaningful phrase
 *   (first line / first comma-separated item). Cap at 60 chars.
 *
 * COUNTRY DETECTION:
 *   SerpAPI needs a country code for localized results.
 *   We derive it from BusinessContext.company.targetRegions.
 *   If not set, default to 'us' (most common SerpAPI default).
 *   This ensures a Udaipur business gets Indian SERP results, not US ones.
 *
 * IDEMPOTENCY:
 *   Always overwrites mainCompetitors — safe on retry.
 *   SERP results are real-time — fresh data on retry is fine.
 *
 * ERROR HANDLING:
 *   - BusinessContext missing → throws → BullMQ retries
 *   - Core keyword extraction fails → throws with clear message
 *   - SerpAPI call fails → throws → BullMQ retries with backoff
 *   - Zero competitors after filtering → warns but completes
 *     (downstream keyword research will still run with empty list,
 *      which is better than blocking the whole pipeline)
 */

import type { Job } from 'bullmq';
import { logger }          from '@/open-tele';
import { Project }         from '@/models/Project';
import { BusinessContext } from '@/models/BusinessContext';
import { searchOrganic, filterCompetitorDomains, deriveCountryCodeFromRegions } from '@/lib/serp';
import type { PipelineJobData } from '../seo-pipeline.worker';
import { crawlSinglePage } from '@/lib/crawler';

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_COMPETITORS   = 10;
const MAX_KEYWORD_LEN   = 60; // chars — longer queries return noisier SERP results

/**
 * Country code map — derived from common region strings in BusinessContext.
 * Covers the most common cases. Falls back to 'us' if no match.
 *
 * SerpAPI country codes: https://serpapi.com/google-countries
 */
const REGION_TO_COUNTRY: Array<{ pattern: RegExp; code: string }> = [
  { pattern: /india|rajasthan|udaipur|mumbai|delhi|bangalore|hyderabad|chennai|kolkata/i, code: 'in' },
  { pattern: /united kingdom|uk|england|scotland|wales/i,                                  code: 'gb' },
  { pattern: /australia|sydney|melbourne|brisbane/i,                                       code: 'au' },
  { pattern: /canada|toronto|vancouver|montreal/i,                                         code: 'ca' },
  { pattern: /germany|berlin|munich|frankfurt/i,                                           code: 'de' },
  { pattern: /france|paris|lyon|marseille/i,                                               code: 'fr' },
  { pattern: /singapore/i,                                                                  code: 'sg' },
  { pattern: /uae|dubai|abu dhabi/i,                                                       code: 'ae' },
  { pattern: /united states|usa|us|new york|california|texas/i,                           code: 'us' },
];

// ── Core keyword extraction ────────────────────────────────────────────────

/**
 * Extracts a clean, short keyword phrase from a raw string.
 * Raw strings may be comma-separated, newline-separated, or bullet-pointed.
 *
 * Strategy:
 *   1. Split on newlines and commas
 *   2. Take the first non-empty, non-bullet item
 *   3. Strip leading dashes/bullets/numbers
 *   4. Cap at MAX_KEYWORD_LEN chars
 *   5. Return null if nothing useful found
 */
function extractFirstKeyword(raw: string | undefined): string | null {
  if (!raw || raw.trim().length === 0) return null;

  const candidates = raw
    .split(/[\n,]+/)
    .map(s => s
      .replace(/^[-•*\d.)\s]+/, '') // strip bullets, dashes, numbered lists
      .trim()
    )
    .filter(s => s.length > 3 && s.length <= MAX_KEYWORD_LEN);

  return candidates[0] ?? null;
}

/**
 * Derives the business's core keyword from BusinessContext.
 * Falls back through a priority chain — never returns null
 * (worst case: uses the domain name).
 */
function extractCoreKeyword(
  bc:
  { company?: { description?: string; targetRegions?: string[] }; 
    customers?: { topUseCases?: string; keywordsTheyUse?: string }; 
    product?: { whatItSells?: string }; competition?: { mainCompetitors?: string[] } 
  },
  domain:    string,
  projectId: string,
): string {
  // Priority 1: topUseCases — highest signal ("below MRP cleaning products Udaipur")
  const fromUseCases = extractFirstKeyword(bc.customers?.topUseCases);
  if (fromUseCases) {
    logger.debug('Core keyword from topUseCases', { projectId, keyword: fromUseCases });
    return fromUseCases;
  }

  // Priority 2: keywordsTheyUse — what customers search
  const fromKeywords = extractFirstKeyword(bc.customers?.keywordsTheyUse);
  if (fromKeywords) {
    logger.debug('Core keyword from keywordsTheyUse', { projectId, keyword: fromKeywords });
    return fromKeywords;
  }

  // Priority 3: whatItSells — product description
  const fromProduct = extractFirstKeyword(bc.product?.whatItSells);
  if (fromProduct) {
    logger.debug('Core keyword from whatItSells', { projectId, keyword: fromProduct });
    return fromProduct;
  }

  // Priority 4: company description
  const fromDescription = extractFirstKeyword(bc.company?.description);
  if (fromDescription) {
    logger.debug('Core keyword from company description', { projectId, keyword: fromDescription });
    return fromDescription;
  }

  // Priority 5: domain name — last resort
  const fromDomain = domain.replace(/\.(com|in|net|org|co\.in|io)$/, '').replace(/-/g, ' ');
  logger.warn('Core keyword falling back to domain name', { projectId, keyword: fromDomain });
  return fromDomain;
}

// ── Main job handler ───────────────────────────────────────────────────────

export async function runCompetitorDiscoveryJob(job: Job<PipelineJobData>): Promise<void> {
  const { projectId } = job.data;

  logger.info('Competitor discovery job started', { projectId, jobId: job.id });

  // 1. Load project — need domain to exclude from competitor list
  const project = await Project.findById(projectId).lean();
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  logger.debug('Project loaded', { projectId, domain: project.domain });

  // 2. Load BusinessContext — need core keyword + target regions
  const bc = await BusinessContext.findOne({ projectId }).lean();
  if (!bc) {
    throw new Error(
      `BusinessContext not found for project ${projectId}. ` +
      `Ensure BUSINESS_PROFILE step completed successfully.`
    );
  }

  logger.debug('BusinessContext loaded', {
    projectId,
    hasTopUseCases:    !!bc.customers?.topUseCases,
    hasKeywordsTheyUse: !!bc.customers?.keywordsTheyUse,
    hasWhatItSells:    !!bc.product?.whatItSells,
    hasTargetRegions:  (bc.company?.targetRegions?.length ?? 0) > 0,
    existingCompetitors: bc.competition?.mainCompetitors?.length ?? 0,
  });

  // 3. Extract core keyword
  const coreKeyword = extractCoreKeyword(bc, project.domain, projectId);

  logger.info('Core keyword extracted for competitor search', {
    projectId,
    coreKeyword,
    domain: project.domain,
  });

  // 4. Derive country code for localized SERP results
  const countryCode = deriveCountryCodeFromRegions(bc.company?.targetRegions, projectId);

  // 5. Run SerpAPI search — throws on failure → BullMQ retries
  const serpResult = await searchOrganic(
    coreKeyword,
    countryCode,
    projectId,
    10, // fetch top 10 — we'll filter down
  );

  logger.info('SERP results received', {
    projectId,
    coreKeyword,
    countryCode,
    totalResults:    serpResult.totalResults,
    organicCount:    serpResult.organicResults.length,
    rawDomains:      serpResult.organicResults.map(r => r.domain),
  });

  // 6. Filter: remove own domain + generic non-competitors + deduplicate
  const allDomains        = serpResult.organicResults.map(r => r.domain);
  const competitorDomains = filterCompetitorDomains(allDomains, project.domain, MAX_COMPETITORS);

  logger.info('Competitor domains after filtering', {
    projectId,
    rawCount:      allDomains.length,
    filteredCount: competitorDomains.length,
    competitors:   competitorDomains,
  });

  if (competitorDomains.length === 0) {
    // Non-fatal — keyword research will run with empty competitor list
    // This can happen for very niche local businesses with no online competitors
    logger.warn('No competitors found after filtering — pipeline will continue', {
      projectId,
      coreKeyword,
      countryCode,
      rawDomains: allDomains,
    });
  }

  // 7. Upsert competitors into BusinessContext
  //    Always overwrites — fresh SERP data on retry is correct behaviour
  await BusinessContext.findOneAndUpdate(
    { projectId },
    {
      $set: {
        'competition.mainCompetitors': competitorDomains,
      },
    },
    {
      upsert:        false, // Must already exist — created by BUSINESS_PROFILE step
      runValidators: false, // competition field is Mixed — no validators to run
    },
  );
  
  // 8. Crawl competitor homepages — extract content for blog generation context
  //    crawlSinglePage() from lib/crawler.ts — lightweight, no link-following.
  //    Results stored in BusinessContext.competition.competitorInsights.
  //    Non-fatal: if all crawls fail, pipeline continues with domains only.
  if (competitorDomains.length > 0) {
    logger.info('Crawling competitor homepages', {
      projectId,
      count: competitorDomains.length,
    });

    const competitorInsights: Array<{
      domain:      string;
      title:       string;
      description: string;
      h1:          string | null;
      h2s:         string[];
      textSnippet: string;  // first 500 chars — enough for LLM context
      hasSchema:   boolean;
      wordCount:   number;
    }> = [];

    for (const competitorDomain of competitorDomains) {
      const url = `https://${competitorDomain}`;
      try {
        const page = await crawlSinglePage(url, competitorDomain);
        if (!page) {
          logger.debug('Competitor page returned null', { projectId, competitorDomain });
          continue;
        }

        competitorInsights.push({
          domain:      competitorDomain,
          title:       page.title,
          description: page.description,
          h1:          page.h1,
          h2s:         page.h2s.slice(0, 5),       // top 5 h2s only
          textSnippet: page.textContent.slice(0, 500),
          hasSchema:   page.hasSchema,
          wordCount:   page.wordCount,
        });

        logger.debug('Competitor homepage crawled', {
          projectId,
          competitorDomain,
          title:     page.title,
          wordCount: page.wordCount,
          hasSchema: page.hasSchema,
        });

        // Polite delay between competitor crawls
        await new Promise(resolve => setTimeout(resolve, 1_000));

      } catch (err) {
        logger.warn('Competitor homepage crawl failed — skipping', {
          projectId,
          competitorDomain,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (competitorInsights.length > 0) {
      await BusinessContext.findOneAndUpdate(
        { projectId },
        {
          $set: {
            'competition.competitorInsights': competitorInsights,
          },
        },
        { runValidators: false },
      );

      logger.info('Competitor insights stored', {
        projectId,
        crawledCount: competitorInsights.length,
        totalDomains: competitorDomains.length,
      });
    }
  }

  logger.info('BusinessContext.competition.mainCompetitors updated', {
    projectId,
    competitorCount: competitorDomains.length,
    competitors:     competitorDomains,
  });

  logger.info('Competitor discovery job completed', {
    projectId,
    jobId:           job.id,
    coreKeyword,
    countryCode,
    competitorCount: competitorDomains.length,
  });
}
