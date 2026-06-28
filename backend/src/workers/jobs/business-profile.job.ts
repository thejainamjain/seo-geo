/**
 * workers/jobs/business-profile.job.ts
 *
 * WHAT: Generates a structured business profile from crawled page content.
 *       Uses Gemini to analyze the site and populate BusinessContext.
 *
 * PIPELINE POSITION: Step 2 of 8
 * READS:  Redis page cache (written by site-crawl.job.ts)
 *         Project (for domain)
 * WRITES: BusinessContext (upsert — idempotent if job retries)
 *
 * LLM CALL: CUSTOMER_PROFILE_SYSTEM prompt (superset of BUSINESS_DESCRIPTION)
 *   Input:  tier 1-3 pages concatenated, capped at 12,000 chars
 *   Output: structured JSON → mapped to BusinessContext fields
 *
 * IDEMPOTENCY:
 *   Uses findOneAndUpdate with upsert:true — safe to retry.
 *   If job fails after LLM call but before DB write → retry calls LLM again.
 *   LLM call is not idempotent but result will be equivalent — acceptable.
 *
 * ERROR HANDLING:
 *   - Redis cache missing → throws with clear message → BullMQ retries
 *   - LLM returns invalid JSON → extractJson throws → BullMQ retries
 *   - LLM returns valid JSON but missing fields → mapped gracefully (undefined ok)
 *   - DB write fails → throws → BullMQ retries
 */

import type { Job } from 'bullmq';
import { logger }            from '@/open-tele';
import { Project }           from '@/models/Project';
import { BusinessContext }   from '@/models/BusinessContext';
import { getBusinessPages }  from '@/lib/page-selector';
import { generateCustomerProfile } from '@/lib/llm';
import type { PipelineJobData }    from '../seo-pipeline.worker';
import type { CustomerProfileLlmResponse } from '@/lib/llm';

/**
 * Normalizes any LLM output to a plain string.
 * LLMs ignore "string" type hints when descriptions imply lists or objects.
 * Arrays of strings → newline-joined.
 * Arrays of objects → each object JSON.stringified, newline-joined.
 * Objects → JSON.stringified.
 * Primitives → String().
 */
function normalizeToString(val: unknown): string | undefined {
  if (val === null || val === undefined) return undefined;
  if (typeof val === 'string') return val.trim() || undefined;
  if (typeof val === 'boolean') return String(val);
  if (typeof val === 'number') return String(val);
  if (Array.isArray(val)) {
    const joined = val
      .map(v => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)))
      .filter(Boolean)
      .join('\n');
    return joined || undefined;
  }
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

// ── LLM response → BusinessContext field mapper ────────────────────────────

/**
 * Maps the flat LLM JSON response to the nested BusinessContext schema.
 * All fields are optional — missing LLM fields leave DB fields undefined.
 * Never throws — bad LLM fields are skipped gracefully.
 */
function mapLlmResponseToBusinessContext(
  llm:       CustomerProfileLlmResponse,
  projectId: string,
): {
  company:     Record<string, unknown>;
  product:     Record<string, unknown>;
  customers:   Record<string, unknown>;
  competition: Record<string, unknown>;
  socialProof: Record<string, unknown>;
} {
  // Parse competitors — LLM returns a string, we need string[]
  let competitorList: string[] = [];
  const competitorRaw = llm.CompetitorsAndDifferentiation?.MainCompetitors;
  if (competitorRaw) {
    // Could be comma-separated, newline-separated, or already an array
    if (Array.isArray(competitorRaw)) {
      competitorList = competitorRaw as string[];
    } else {
      competitorList = (competitorRaw as string)
        .split(/[\n,]+/)
        .map((s: string) => s.trim())
        .filter(Boolean);
    }
  }

  // Parse target regions — LLM returns a string
  let targetRegions: string[] = [];
  const regionsRaw = llm.TargetRegionsOrLanguages;
  if (regionsRaw) {
    targetRegions = regionsRaw
      .split(/[\n,]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  // Parse customer segments — LLM returns a string
  let segments: string[] = [];
  const segmentsRaw = llm.TargetCustomers?.CustomerSegments;
  if (segmentsRaw) {
    if (Array.isArray(segmentsRaw)) {
      segments = segmentsRaw as string[];
    } else {
      segments = (segmentsRaw as string)
        .split(/[\n,]+/)
        .map(s => s.trim())
        .filter(Boolean);
    }
  }

  logger.debug('LLM response mapped to BusinessContext fields', {
    projectId,
    hasCompany:      !!llm.CompanyName,
    hasProduct:      !!llm.ProductOrService,
    hasCustomers:    !!llm.TargetCustomers,
    hasCompetition:  !!llm.CompetitorsAndDifferentiation,
    hasSocialProof:  !!llm.SocialProofAndTrust,
    competitorCount: competitorList.length,
    segmentCount:    segments.length,
  });

  return {
    company: {
      name:            llm.CompanyName,
      website:         llm.Website,
      targetRegions,
      description:     llm.ProductOrService?.WhatTheBusinessSells,
    },
    customers: {
      segments,
      painPoints:      normalizeToString(llm.TargetCustomers?.CustomerPainPoints),
      keywordsTheyUse: normalizeToString(llm.TargetCustomers?.KeywordsTheyTalkAbout),
      topUseCases:     normalizeToString(llm.TargetCustomers?.TopUseCasesYouWantToRankFor),
    },
    product: {
      whatItSells:            normalizeToString(llm.ProductOrService?.WhatTheBusinessSells),
      keyFeatures:            normalizeToString(llm.ProductOrService?.KeyFeaturesAndBenefits),
      pricingTiers:           normalizeToString(llm.ProductOrService?.ProductTiersAndInclusions),
      freeTrialAvailable:     typeof llm.ProductOrService?.FreeTrialOrDemoAvailability === 'string'
                                ? llm.ProductOrService.FreeTrialOrDemoAvailability.toLowerCase().includes('yes')
                                : false,
      lifetimeValuePerClient: normalizeToString(llm.ProductOrService?.TotalLifetimeValuePerClient),
    },
    competition: {
      mainCompetitors:  competitorList,
      differentiation:  llm.CompetitorsAndDifferentiation?.Differentiation,
      uniqueStrengths:  llm.CompetitorsAndDifferentiation?.UniqueStrengths,
      proof:            llm.CompetitorsAndDifferentiation?.Proof,
      tradeOffs:        llm.CompetitorsAndDifferentiation?.TradeOffsYouAccept,
    },
    socialProof: {
      caseStudies:         llm.SocialProofAndTrust?.CaseStudies,
      organicDiscussions:  llm.SocialProofAndTrust?.OrganicDiscussions,
      socialMediaPresence: llm.SocialProofAndTrust?.SocialMediaPresence,
    },
  };
}

// ── Main job handler ───────────────────────────────────────────────────────

export async function runBusinessProfileJob(job: Job<PipelineJobData>): Promise<void> {
  const { projectId } = job.data;

  logger.info('Business profile job started', { projectId, jobId: job.id });

  // 1. Load project — need domain for LLM prompt
  const project = await Project.findById(projectId).lean();
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const siteUrl = `https://${project.domain}`;

  logger.debug('Project loaded', { projectId, domain: project.domain });

  // 2. Read tier 1-3 pages from Redis (homepage + core business pages)
  //    Throws if cache expired — BullMQ will retry
  const { pages, concatenatedText } = await getBusinessPages(projectId);

  logger.info('Pages loaded for business profile', {
    projectId,
    pageCount: pages.length,
    pages:     pages.map(p => ({ url: p.url, tier: p.tier, title: p.title })),
    textLength: concatenatedText.length,
  });

  // 3. Call Gemini — CUSTOMER_PROFILE_SYSTEM prompt
  //    Throws on rate limit / server error / bad JSON → BullMQ retries
  const llmResponse = await generateCustomerProfile(siteUrl, concatenatedText, projectId);

  logger.info('LLM response received for business profile', {
    projectId,
    hasCompanyName:   !!llmResponse.CompanyName,
    hasProductInfo:   !!llmResponse.ProductOrService,
    hasCustomerInfo:  !!llmResponse.TargetCustomers,
    hasCompetition:   !!llmResponse.CompetitorsAndDifferentiation,
    hasSocialProof:   !!llmResponse.SocialProofAndTrust,
  });

  // 4. Map LLM response to BusinessContext schema
  const mapped = mapLlmResponseToBusinessContext(llmResponse, projectId);

  // 5. Upsert BusinessContext — idempotent, safe on retry
  //    completedSteps: [1,2,3,4,5] — all steps filled by AI
  //    User can override individual steps via onboarding wizard later
  const businessContext = await BusinessContext.findOneAndUpdate(
    { projectId },
    {
      $set: {
        company:        mapped.company,
        product:        mapped.product,
        customers:      mapped.customers,
        competition:    mapped.competition,
        socialProof:    mapped.socialProof,
        completedSteps: [1, 2, 3, 4, 5],
      },
    },
    {
      upsert:    true,   // Create if doesn't exist
      new:       true,   // Return updated document
      runValidators: true,
    },
  );

  logger.info('BusinessContext upserted', {
    projectId,
    businessContextId: String(businessContext._id),
    completedSteps:    businessContext.completedSteps,
    companyName:       String(mapped.company.name ?? ''),
    competitorCount:   (mapped.competition.mainCompetitors as string[]).length,
    segmentCount:      (mapped.customers.segments as string[]).length,
  });

  logger.info('Business profile job completed', {
    projectId,
    jobId:             job.id,
    businessContextId: String(businessContext._id),
  });
}
