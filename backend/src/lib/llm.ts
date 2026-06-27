/**
 * lib/llm.ts
 *
 * WHAT: Gemini API wrapper for all LLM calls in the pipeline.
 *
 * DESIGN:
 *   - Single exported function per use case (not a generic call — each
 *     function has typed input and typed output)
 *   - JSON extraction is robust — strips markdown fences Gemini adds
 *     despite "return only JSON" instructions
 *   - All calls are logged with duration for observability
 *   - Rate limit (429) and server errors (5xx) throw so BullMQ retries
 *   - API key validated at call time — clear error if missing
 *
 * GEMINI MODEL: gemini-1.5-flash
 *   - Free tier: 15 RPM, 1M tokens/day
 *   - Fast enough for pipeline use — not gemini-pro (slower, costs more)
 *
 * ADDING NEW LLM CALLS:
 *   1. Add typed interface for the expected JSON response
 *   2. Add a function that calls callGemini() with the right prompts
 *   3. Export it
 *   Never add raw Gemini calls outside this file.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { PROMPTS } from '../constants/llm.constants';
import { logger } from '../open-tele';
import config from '@/utils/config';

// ── Constants ──────────────────────────────────────────────────────────────

const GEMINI_MODEL = 'gemini-1.5-flash';

// ── Gemini client (lazy singleton) ────────────────────────────────────────
// Lazy so we don't crash at import time if key is missing —
// crash happens at first call with a clear error message.

let _genAI: GoogleGenerativeAI | null = null;

function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) {
    const apiKey = config.gemini.apiKey();
    if (!apiKey) throw new Error('GEMINI_API_KEY is not defined in environment');
    _genAI = new GoogleGenerativeAI(apiKey);
  }
  return _genAI;
}

// ── JSON extraction ────────────────────────────────────────────────────────
/**
 * Gemini sometimes wraps JSON in ```json ... ``` fences despite instructions.
 * This strips fences and extracts the first valid JSON object or array.
 *
 * Strategy:
 *   1. Strip ```json / ``` markdown fences
 *   2. Find first { or [ character
 *   3. Find matching closing } or ]
 *   4. Parse that substring
 *   5. Throw clearly if none found — upstream retries
 */
function extractJson<T>(raw: string, context: string): T {
  // Step 1: strip markdown fences
  let cleaned = raw
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  // Step 2-3: find outermost JSON structure
  const firstBrace   = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');

  let startIndex: number;
  let openChar:   string;
  let closeChar:  string;

  if (firstBrace === -1 && firstBracket === -1) {
    throw new Error(`LLM returned no JSON structure. Context: ${context}. Raw: ${cleaned.slice(0, 200)}`);
  }

  if (firstBrace === -1 || (firstBracket !== -1 && firstBracket < firstBrace)) {
    startIndex = firstBracket;
    openChar   = '[';
    closeChar  = ']';
  } else {
    startIndex = firstBrace;
    openChar   = '{';
    closeChar  = '}';
  }

  // Step 3: find matching closing character using depth counter
  let depth = 0;
  let endIndex = -1;
  for (let i = startIndex; i < cleaned.length; i++) {
    if (cleaned[i] === openChar)  depth++;
    if (cleaned[i] === closeChar) depth--;
    if (depth === 0) { endIndex = i; break; }
  }

  if (endIndex === -1) {
    throw new Error(`LLM returned malformed JSON (unmatched braces). Context: ${context}`);
  }

  const jsonStr = cleaned.slice(startIndex, endIndex + 1);

  try {
    return JSON.parse(jsonStr) as T;
  } catch (err) {
    throw new Error(
      `LLM JSON parse failed. Context: ${context}. ` +
      `Error: ${err instanceof Error ? err.message : String(err)}. ` +
      `Raw snippet: ${jsonStr.slice(0, 300)}`
    );
  }
}

// ── Core Gemini call ───────────────────────────────────────────────────────
/**
 * Base function — all LLM calls go through here.
 * Handles: logging, duration tracking, error classification.
 *
 * Throws on:
 *   - 429 rate limit    → BullMQ retries with backoff
 *   - 5xx server error  → BullMQ retries with backoff
 *   - Empty response    → BullMQ retries
 *   - Invalid JSON      → BullMQ retries
 */
export async function callGemini(
  systemPrompt: string,
  userPrompt:   string,
  context:      string, // for logging — e.g. "business-profile:projectId"
): Promise<string> {
  const startedAt = Date.now();

  logger.debug('Gemini call started', {
    context,
    model:            GEMINI_MODEL,
    systemPromptLen:  systemPrompt.length,
    userPromptLen:    userPrompt.length,
  });

  try {
    const genAI = getGenAI();
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: systemPrompt,
    });

    const result = await model.generateContent(userPrompt);
    const response = result.response;

    // Check for blocked content (Gemini safety filters)
    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
      throw new Error(
        `Gemini blocked response. Finish reason: ${finishReason}. Context: ${context}`
      );
    }

    const text = response.text();

    if (!text || text.trim().length === 0) {
      throw new Error(`Gemini returned empty response. Context: ${context}`);
    }

    const durationMs = Date.now() - startedAt;
    logger.info('Gemini call completed', {
      context,
      model:       GEMINI_MODEL,
      durationMs,
      outputLen:   text.length,
      finishReason: finishReason ?? 'STOP',
    });

    return text;

  } catch (err) {
    const durationMs = Date.now() - startedAt;

    // Classify error for logging — rate limit vs server error vs other
    const message = err instanceof Error ? err.message : String(err);
    const isRateLimit   = message.includes('429') || message.toLowerCase().includes('rate limit');
    const isServerError = message.includes('500') || message.includes('503');

    logger.error(
      err instanceof Error ? err : new Error(message),
      {
        context,
        model:      GEMINI_MODEL,
        durationMs,
        isRateLimit,
        isServerError,
      },
    );

    // Rethrow — BullMQ handles retry with exponential backoff
    throw err;
  }
}

// ── Typed response interfaces ──────────────────────────────────────────────

export interface CustomerProfileLlmResponse {
  CompanyName?:             string;
  Website?:                 string;
  TargetRegionsOrLanguages?: string;
  ProductOrService?: {
    WhatTheBusinessSells?:       string;
    KeyFeaturesAndBenefits?:     string;
    ProductTiersAndInclusions?:  string;
    FreeTrialOrDemoAvailability?: string;
    TotalLifetimeValuePerClient?: string;
  };
  TargetCustomers?: {
    CustomerSegments?:        string;
    CustomerPainPoints?:      string;
    KeywordsTheyTalkAbout?:   string;
    TopUseCasesYouWantToRankFor?: string;
  };
  CompetitorsAndDifferentiation?: {
    MainCompetitors?:   string;
    Differentiation?:   string;
    UniqueStrengths?:   string;
    Proof?:             string;
    TradeOffsYouAccept?: string;
  };
  SocialProofAndTrust?: {
    CaseStudies?:          string;
    OrganicDiscussions?:   string;
    SocialMediaPresence?:  string;
  };
}

export interface KeywordAlignmentLlmResponse {
  keywords: Array<{
    keyword:        string;
    reasoning:      string;
    relevant:       boolean;
    alignmentScore: number;
  }>;
}

export interface SerpAnalysisLlmResponse {
  serpRelevance: Array<{
    title:                                      string;
    topic:                                      string;
    link:                                       string;
    pageType:                                   string;
    titleIntentReasoning:                       string;
    titleIntent:                                string;
    contentAboutCompetitorReasoning:            string;
    contentAboutCompetitor:                     boolean;
    contentAboutCompetitorAlternativesOrReview: boolean;
    businessRelevanceReasoning:                 string;
    isRelevantToBusiness:                       boolean;
    icpRelevanceReasoning:                      string;
    isRelevantToICP:                            boolean;
  }>;
}

export interface BlogGenerationLlmResponse {
  title:       string;
  slug:        string;
  description: string;
  content:     string;
  schema:      Record<string, unknown>; // mapped to seoSchema on Blog model
}

export interface MarketSizingLlmResponse {
  keywords: Array<{
    title:         string;
    keyword:       string;
    difficulty:    number;
    search_volume: number;
  }>;
  calculations:       string;
  totalSearchVolume:  number;
  marketCountryAlpha3: string;
}

export interface PageAuditLlmResponse {
  title?:            string;
  description?:      string;
  ogTitle?:          string;
  ogDescription?:    string;
  altTexts?:         Record<string, string>;
  schema?:           Record<string, unknown>;
  faqQuestions?:     Array<{ question: string; answer: string }>;
  tldrText?:         string;
  brokenLinkFix?:    string;  // Suggested anchor text replacement or removal note
  contentExpansion?: string;  // Topics to add to expand thin content
  redirectFix?:      string;  // Which URLs to update to point to final URL
  h1Suggestion?:     string;  // Suggested H1 tag text
  schemaFix?:        string;  // What fields are missing and suggested values
  speedFix?:         string;  // Performance improvement suggestions
  canonicalFix?:     string;  // Explanation of canonical mismatch + fix
  pageSizeFix?:      string;  // What's making the page large + fix suggestions
}

export interface SeoScoreLlmResponse {
  score:     number;
  reasoning: string;
}


// ── Exported LLM functions ─────────────────────────────────────────────────

/**
 * Generates a full customer/business profile from crawled page content.
 * Used by: business-profile.job.ts
 *
 * Returns structured data matching BusinessContext model fields.
 */
export async function generateCustomerProfile(
  siteUrl:        string,
  crawledContent: string,
  projectId:      string,
): Promise<CustomerProfileLlmResponse> {
  const raw = await callGemini(
    PROMPTS.CUSTOMER_PROFILE_SYSTEM,
    PROMPTS.CUSTOMER_PROFILE_USER(siteUrl, crawledContent),
    `customer-profile:${projectId}`,
  );
  return extractJson<CustomerProfileLlmResponse>(raw, `customer-profile:${projectId}`);
}

/**
 * Scores a list of keywords for alignment to the business.
 * Used by: keyword-research.job.ts
 */
export async function scoreKeywordAlignment(
  keywordList:       string,
  domainDescription: string,
  projectId:         string,
): Promise<KeywordAlignmentLlmResponse> {
  const raw = await callGemini(
    PROMPTS.KEYWORD_ALIGNMENT_SYSTEM(domainDescription),
    PROMPTS.KEYWORD_ALIGNMENT_USER(keywordList),
    `keyword-alignment:${projectId}`,
  );
  return extractJson<KeywordAlignmentLlmResponse>(raw, `keyword-alignment:${projectId}`);
}

/**
 * Analyzes SERP results for a keyword.
 * Used by: serp-research.job.ts
 */
export async function analyzeSerpResults(
  keyword:           string,
  serpResults:       string,
  domainDescription: string,
  projectId:         string,
): Promise<SerpAnalysisLlmResponse> {
  const raw = await callGemini(
    PROMPTS.SERP_ANALYSIS_SYSTEM(keyword, domainDescription),
    PROMPTS.SERP_ANALYSIS_USER(keyword, serpResults),
    `serp-analysis:${projectId}:${keyword}`,
  );
  return extractJson<SerpAnalysisLlmResponse>(raw, `serp-analysis:${projectId}:${keyword}`);
}

/**
 * Generates a full blog post for a keyword.
 * Used by: blog-generation.job.ts (when LLM is wired in)
 */
export async function generateBlogPost(
  keyword:         string,
  customerProfile: string,
  sourceAnalysis:  string,
  knowledgeChunks: string,
  contactUrl:      string,
  projectId:       string,
  keywordId:       string,
): Promise<BlogGenerationLlmResponse> {
  const raw = await callGemini(
    PROMPTS.BLOG_GENERATION_SYSTEM(customerProfile, keyword, sourceAnalysis, knowledgeChunks, contactUrl),
    PROMPTS.BLOG_GENERATION_USER(keyword),
    `blog-generation:${projectId}:${keywordId}`,
  );
  return extractJson<BlogGenerationLlmResponse>(raw, `blog-generation:${projectId}:${keywordId}`);
}

/**
 * Generates initial market sizing and keyword ideas from business description.
 * Used by: keyword-research.job.ts
 */
export async function generateMarketSizing(
  domainDescription: string,
  country:           string,
  projectId:         string,
): Promise<MarketSizingLlmResponse> {
  const raw = await callGemini(
    PROMPTS.MARKET_SIZING_SYSTEM,
    PROMPTS.MARKET_SIZING_USER(domainDescription, country),
    `market-sizing:${projectId}`,
  );
  return extractJson<MarketSizingLlmResponse>(raw, `market-sizing:${projectId}`);
}



/**
 * Audits a single page — generates all missing SEO fixes in one LLM call.
 * Used by: technical-audit.job.ts
 *
 * @param url         - Page URL (context for LLM)
 * @param title       - Current page title (may be empty)
 * @param description - Current meta description (may be empty)
 * @param textContent - Page text content, will be truncated inside prompt
 * @param needs       - List of fields to generate (only what's missing)
 * @param imageSrcs   - Image src URLs that need alt text generated
 * @param projectId   - For logging context
 */
export async function auditPage(
  url:         string,
  title:       string,
  description: string,
  textContent: string,
  needs:       string[],
  imageSrcs:   string[],
  projectId:   string,
): Promise<PageAuditLlmResponse> {
  if (needs.length === 0) {
    // Nothing to generate — caller should have filtered this page out
    logger.warn('auditPage called with empty needs list — returning empty', {
      projectId, url,
    });
    return {};
  }

  const context = `page-audit:${projectId}:${url}`;

  const raw = await callGemini(
    PROMPTS.PAGE_AUDIT_SYSTEM,
    PROMPTS.PAGE_AUDIT_USER(url, title, description, textContent, needs, imageSrcs),
    context,
  );

  return extractJson<PageAuditLlmResponse>(raw, context);
}

/**
 * Calculates an SEO score for the project based on audit results.
 * Used by: technical-audit.job.ts (once per audit run, not per page)
 *
 * @param siteUrl         - The project's domain URL
 * @param actualScore     - Raw score (weighted passes)
 * @param totalPossible   - Maximum possible score
 * @param weightedPassRate - Percentage of weighted checks that passed
 * @param projectId       - For logging context
 */
export async function generateSeoScore(
  siteUrl:          string,
  actualScore:      number,
  totalPossible:    number,
  weightedPassRate: number,
  projectId:        string,
): Promise<SeoScoreLlmResponse> {
  const context = `seo-score:${projectId}`;

  const raw = await callGemini(
    PROMPTS.SEO_SCORE_SYSTEM,
    PROMPTS.SEO_SCORE_USER(siteUrl, actualScore, totalPossible, weightedPassRate),
    context,
  );

  const result = extractJson<SeoScoreLlmResponse>(raw, context);

  // Guard — clamp score to valid range in case LLM hallucinates
  result.score = Math.min(100, Math.max(1, Math.round(result.score)));

  return result;
}
