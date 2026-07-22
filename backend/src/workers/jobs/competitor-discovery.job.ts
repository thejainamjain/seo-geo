/**
 * workers/jobs/competitor-discovery.job.ts
 *
 * WHAT: Discovers real competitors two ways — (1) verifies any existing
 *       user-entered or AI-drafted competitor entries via crawl + LLM
 *       judgment, and (2) runs a Google SERP search for the business's
 *       core keyword and adds the domains that actually rank. MERGES
 *       both into BusinessContext.competition.mainCompetitors — never
 *       overwrites a human's manual input. See
 *       docs/05-phase4-competitor-discovery-audit.md for the history of
 *       why this changed from "always overwrite" to "verify and merge."
 *
 * PIPELINE POSITION: Step 4 of 8
 * READS:  BusinessContext (for core keyword, target region, and any
 *         existing mainCompetitors entries from onboarding step 4 or the
 *         AI's initial business-profile draft)
 *         Project (for own domain to exclude)
 * WRITES: BusinessContext.competition.mainCompetitors (CompetitorEntry[])
 *         BusinessContext.competition.competitorInsights
 *
 * WHY SERP-BASED (not LLM-guessed) FOR DISCOVERY:
 *   LLM hallucination risk is high for competitor lists.
 *   Gemini/Groq will confidently name competitors that don't exist or
 *   don't actually rank for the same keywords.
 *   SerpAPI gives us ground truth — real domains that Google ranks
 *   for the business's core keyword RIGHT NOW.
 *   This is exactly what RankAI does (visible in their UI screenshots).
 *
 * WHY VERIFY EXISTING ENTRIES (not just trust or discard them):
 *   A user-typed or AI-drafted domain has no external ground truth behind
 *   it the way a SERP ranking does. Rather than blindly trusting it (could
 *   be wrong) or blindly overwriting it (destroys real human input), we
 *   crawl the candidate's homepage and ask the LLM a narrow question: does
 *   this actually look like a competitor, based on real page content? A
 *   failed check doesn't delete the entry — it's kept with
 *   verified:false and a reasoning string, so the user can see why and
 *   decide, rather than their input silently vanishing.
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
 *   Safe on retry — SERP-discovered domains already in the list are
 *   skipped (not re-added), and already-verified entries are not
 *   re-verified (avoids burning LLM calls on retry). Only genuinely new
 *   SERP domains and still-unverified entries do work on a retry.
 *
 * ERROR HANDLING:
 *   - BusinessContext missing → throws → BullMQ retries
 *   - Core keyword extraction fails → throws with clear message
 *   - SerpAPI call fails → throws → BullMQ retries with backoff
 *   - Zero competitors after filtering → warns but completes
 *     (downstream keyword research will still run with empty list,
 *      which is better than blocking the whole pipeline)
 *   - A single candidate's verification crawl/LLM call failing is
 *     non-fatal — that entry just stays verified:false, job continues
 */

import type { Job } from 'bullmq';
import { logger }          from '@/open-tele';
import { Project }         from '@/models/Project';
import { BusinessContext } from '@/models/BusinessContext';
import type { CompetitorEntry } from '@/models/BusinessContext';
import { searchOrganic, filterCompetitorDomains, deriveCountryCodeFromRegions } from '@/lib/serp';
import type { PipelineJobData } from '../seo-pipeline.worker';
import { crawlSinglePage } from '@/lib/crawler';
import { verifyCompetitor } from '@/lib/llm';

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_COMPETITORS   = 10; // cap on SERP-discovered candidates fetched per run
const MAX_COMPETITORS_TOTAL = 15; // cap on the final merged list (existing + SERP)
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
function extractFirstKeyword(raw: string | string[] | undefined): string | null {
  if (!raw) return null;
  // Normalize array — LLM returns arrays despite string instructions
  const str = Array.isArray(raw) ? (raw[0] ?? '') : raw;
  if (typeof str !== 'string' || str.trim().length === 0) return null;

  const candidates = str
    .split(/[\n,]+/)
    .map(s => s.replace(/^[-•*\d.)\s]+/, '').trim())
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
    product?: { whatItSells?: string }; competition?: { mainCompetitors?: CompetitorEntry[] } 
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
  const allDomains  = serpResult.organicResults.map(r => r.domain);
  const serpDomains = filterCompetitorDomains(allDomains, project.domain, MAX_COMPETITORS);

  logger.info('SERP-discovered competitor domains after filtering', {
    projectId,
    rawCount:      allDomains.length,
    filteredCount: serpDomains.length,
    competitors:   serpDomains,
  });

  // 7. Build a short business description for the LLM verification step —
  //    same fields used elsewhere for LLM context, kept short.
  const businessDescription = [
    bc.company?.description,
    bc.product?.whatItSells,
    bc.customers?.topUseCases,
  ].filter(Boolean).join(' ') || `A business at ${project.domain}`;

  // 8. Load existing entries (from onboarding step 4 and/or the AI's
  //    initial business-profile draft) into a domain → entry map.
  //    This is the merge base — nothing here gets silently dropped.
  const existingEntries = bc.competition?.mainCompetitors ?? [];
  const merged = new Map<string, CompetitorEntry>();
  for (const entry of existingEntries) {
    const key = entry.domain.replace(/^www\./, '').toLowerCase();
    if (key) merged.set(key, entry);
  }

  logger.debug('Existing competitor entries loaded for merge', {
    projectId,
    existingCount:   existingEntries.length,
    alreadyVerified: existingEntries.filter(e => e.verified).length,
  });

  // Track pages we crawl along the way so step 11 (insights) doesn't
  // re-crawl the same domain twice.
  const crawledPages = new Map<string, Awaited<ReturnType<typeof crawlSinglePage>>>();

  // 9. Merge in SERP results. A SERP domain ranking for the core keyword
  //    IS its own verification — no LLM check needed for these. If a SERP
  //    domain happens to match an existing (previously unverified) entry,
  //    that's real confirmation for it too — upgrade it in place rather
  //    than creating a duplicate.
  for (const domain of serpDomains) {
    const key = domain.replace(/^www\./, '').toLowerCase();
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, {
        domain:   key,
        source:   'serp',
        verified: true,
        addedAt:  new Date(),
      });
    } else if (!existing.verified) {
      merged.set(key, {
        ...existing,
        verified:              true,
        verificationReasoning: `Confirmed via live SERP ranking for "${coreKeyword}".`,
      });
    }
    // If existing && existing.verified — already confirmed, leave as-is.
  }

  // 10. Verify remaining unverified entries (user-entered or AI-drafted,
  //     not confirmed by the SERP pass above) via crawl + LLM judgment.
  //     Non-fatal per entry — a failed check stays verified:false with a
  //     reason, never silently dropped.
  const stillUnverified = [...merged.values()].filter(e => !e.verified);

  logger.info('Verifying remaining unverified competitor entries', {
    projectId,
    count: stillUnverified.length,
  });

  for (const entry of stillUnverified) {
    const url = `https://${entry.domain}`;
    try {
      const page = await crawlSinglePage(url, entry.domain);
      if (!page) {
        merged.set(entry.domain, {
          ...entry,
          verificationReasoning: 'Could not reach this domain to verify it automatically.',
        });
        continue;
      }
      crawledPages.set(entry.domain, page);

      const verdict = await verifyCompetitor(
        businessDescription,
        entry.domain,
        page.title,
        page.description,
        page.textContent,
        projectId,
      );

      merged.set(entry.domain, {
        ...entry,
        verified:              verdict.isCompetitor,
        verificationReasoning: verdict.reasoning,
      });

      logger.debug('Competitor entry verified', {
        projectId,
        domain:   entry.domain,
        source:   entry.source,
        verified: verdict.isCompetitor,
      });

      // Polite delay between candidate crawls
      await new Promise(resolve => setTimeout(resolve, 1_000));

    } catch (err) {
      // Verification failure is non-fatal — keep the entry, mark why it
      // couldn't be checked, move on to the next one.
      logger.warn('Competitor verification failed — leaving unverified', {
        projectId,
        domain: entry.domain,
        error:  err instanceof Error ? err.message : String(err),
      });
      merged.set(entry.domain, {
        ...entry,
        verificationReasoning: 'Automatic verification failed — could not confirm.',
      });
    }
  }

  // 11. Cap the final list — verified entries first (highest confidence),
  //     preserve relative order within each group.
  const allEntries = [...merged.values()];
  const finalEntries = [
    ...allEntries.filter(e => e.verified),
    ...allEntries.filter(e => !e.verified),
  ].slice(0, MAX_COMPETITORS_TOTAL);

  logger.info('Competitor list merged', {
    projectId,
    existingCount: existingEntries.length,
    serpCount:     serpDomains.length,
    finalCount:    finalEntries.length,
    verifiedCount: finalEntries.filter(e => e.verified).length,
  });

  if (finalEntries.length === 0) {
    // Non-fatal — keyword research will run with empty competitor list
    // This can happen for very niche local businesses with no online competitors
    logger.warn('No competitors found after merge — pipeline will continue', {
      projectId,
      coreKeyword,
      countryCode,
      rawDomains: allDomains,
    });
  }

  // 12. Write the merged (not overwritten) list back to BusinessContext
  await BusinessContext.findOneAndUpdate(
    { projectId },
    {
      $set: {
        'competition.mainCompetitors': finalEntries,
      },
    },
    {
      upsert:        false, // Must already exist — created by BUSINESS_PROFILE step
      runValidators: false, // competition field is Mixed — no validators to run
    },
  );

  // 13. Crawl remaining competitor homepages — extract content for blog
  //     generation context. Reuses crawls already done during verification
  //     (step 10) instead of re-fetching the same domain twice.
  //     Non-fatal: if all crawls fail, pipeline continues with domains only.
  if (finalEntries.length > 0) {
    logger.info('Building competitor insights', {
      projectId,
      count: finalEntries.length,
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

    for (const entry of finalEntries) {
      const competitorDomain = entry.domain;
      try {
        let page = crawledPages.get(competitorDomain);
        if (!page) {
          const url = `https://${competitorDomain}`;
          page = await crawlSinglePage(url, competitorDomain);
          // Polite delay only when we actually crawl (not for cache hits)
          await new Promise(resolve => setTimeout(resolve, 1_000));
        }

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
        totalDomains: finalEntries.length,
      });
    }
  }

  logger.info('BusinessContext.competition.mainCompetitors updated', {
    projectId,
    competitorCount: finalEntries.length,
    competitors:     finalEntries.map(e => e.domain),
  });

  logger.info('Competitor discovery job completed', {
    projectId,
    jobId:           job.id,
    coreKeyword,
    countryCode,
    competitorCount: finalEntries.length,
  });
}
