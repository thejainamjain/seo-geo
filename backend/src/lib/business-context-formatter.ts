import { normalizeToStringArray } from '../utils/normalize';

/**
 * Shared utility — formats BusinessContext into a compact string for LLM prompts.
 * Used by: blog-generation.job.ts, content-generation.job.ts
 * 
 * Kept under ~2000 chars — enough context without overwhelming the prompt.
 * All fields expected as strings (normalized by business-profile.job.ts mapper).
 */
export function formatBusinessContext(bc: {
  company?:     { name?: string; description?: string; targetRegions?: string[] };
  product?:     { whatItSells?: string; keyFeatures?: string; pricingTiers?: string };
  customers?:   { segments?: string[]; painPoints?: string; topUseCases?: string; keywordsTheyUse?: string };
  competition?: { differentiation?: string; uniqueStrengths?: string };
  socialProof?: { caseStudies?: string };
}): string {
  const lines: string[] = [];

  if (bc.company?.name)                lines.push(`Company: ${bc.company.name}`);
  if (bc.company?.description)         lines.push(`About: ${bc.company.description}`);
  // Defensive: company is Schema.Types.Mixed on the backend, so this
  // string[] type is not enforced at the DB layer — a legacy record can
  // still hold targetRegions as a plain string. See utils/normalize.ts.
  const targetRegions = normalizeToStringArray(bc.company?.targetRegions);
  if (targetRegions.length)
    lines.push(`Markets: ${targetRegions.join(', ')}`);
  if (bc.product?.whatItSells)         lines.push(`Product: ${bc.product.whatItSells}`);
  if (bc.product?.keyFeatures)         lines.push(`Features: ${bc.product.keyFeatures}`);
  if (bc.product?.pricingTiers)        lines.push(`Pricing: ${bc.product.pricingTiers}`);
  if (bc.customers?.segments?.length)
    lines.push(`Customer segments: ${bc.customers.segments.join(', ')}`);
  if (bc.customers?.painPoints)        lines.push(`Pain points: ${bc.customers.painPoints}`);
  if (bc.customers?.topUseCases)       lines.push(`Top use cases: ${bc.customers.topUseCases}`);
  // Added when keyword-research.job.ts switched from its own narrower,
  // ad-hoc description to this shared formatter — this field ("words
  // customers actually search with") was in that job's old description
  // but missing here entirely, and is arguably the single most
  // keyword-relevant field BusinessContext has. Every caller benefits
  // from it, not just keyword research.
  if (bc.customers?.keywordsTheyUse)   lines.push(`Keywords customers use: ${bc.customers.keywordsTheyUse}`);
  if (bc.competition?.differentiation) lines.push(`Differentiation: ${bc.competition.differentiation}`);
  if (bc.competition?.uniqueStrengths) lines.push(`Strengths: ${bc.competition.uniqueStrengths}`);
  if (bc.socialProof?.caseStudies)     lines.push(`Case studies: ${bc.socialProof.caseStudies}`);

  return lines.join('\n').slice(0, 2_000);
}
