/**
 * lib/llm.ts
 *
 * WHAT: LLM wrapper for all pipeline LLM calls.
 *       Groq is primary; Gemini is the fallback (used only when Groq
 *       rate-limits, so it's still one BullMQ attempt, not a wasted one).
 *
 * DESIGN:
 *   - Single exported function per use case (not a generic call — each
 *     function has typed input and typed output)
 *   - JSON extraction is robust — strips markdown fences either provider
 *     sometimes adds despite "return only JSON" instructions
 *   - All calls are logged with duration for observability
 *   - Rate limit (429) and server errors (5xx) throw so BullMQ retries
 *   - API key validated at call time — clear error if missing
 *
 * ADDING NEW LLM CALLS:
 *   1. Add typed interface for the expected JSON response
 *   2. Add a function that calls callLLM() with the right prompts
 *   3. Export it
 *   Never add raw Groq/Gemini calls outside this file.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  PROMPTS,
  CUSTOMER_PROFILE_JSON_SCHEMA,
  COMPETITOR_RELEVANCE_SYSTEM,
  COMPETITOR_RELEVANCE_USER,
  COMPETITOR_RELEVANCE_JSON_SCHEMA,
} from '../constants/llm.constants';
import { logger } from '../open-tele';
import config from '@/utils/config';
import { getRedis } from '../loaders/redis';
import Groq from 'groq-sdk';
import { LLM_RATE_LIMIT } from '../constants/seo-pipeline.constants';

// ── Constants ──────────────────────────────────────────────────────────────

const GEMINI_MODEL = 'gemini-2.0-flash';
const GROQ_MODEL = process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b';

// Groq's compound system — does real, server-side live web search (via
// Tavily) before answering, with actual executed_tools.search_results
// returned alongside the answer. Used only by geoCitationCheck() below,
// since that's the one call that needs live grounding, not just a fast
// chat completion. Confirmed against the installed groq-sdk (v1.3.0) type
// definitions — 'compound-beta' is the literal supported by this SDK
// version (docs also reference 'groq/compound' as a newer alias; sticking
// to the type-checked literal here).
const GROQ_COMPOUND_MODEL = 'compound-beta';

// ── Gemini client (lazy singleton) ────────────────────────────────────────
// Lazy so we don't crash at import time if key is missing —
// crash happens at first call with a clear error message.

let _genAI: GoogleGenerativeAI | null = null;


export function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) {
    const apiKey = config.gemini.apiKey();
    if (!apiKey) throw new Error('GEMINI_API_KEY is not defined in environment');
    _genAI = new GoogleGenerativeAI(apiKey);
  }
  return _genAI;
}

let _groq: Groq | null = null;

function getGroq(): Groq {
  if (!_groq) {
    const apiKey = config.groq.apiKey();
    if (!apiKey) throw new Error('GROQ_API_KEY is not defined in environment');
    _groq = new Groq({ apiKey });
  }
  return _groq;
}

// ── Global LLM rate limiter ────────────────────────────────────────────────
/**
 * Enforces a global 14 RPM ceiling across ALL worker processes.
 * Uses a Redis sliding window counter keyed by current minute.
 * Blocks (polls every 2s) until a slot is available.
 *
 * Key: llm:rpm:{minute} — auto-expires after 60s, no cleanup needed.
 * Limit: 14 (not 15) — 1 call buffer for safety.
 *
 * Redis commands per Gemini call: 2 (INCR + EXPIRE on first call per minute).
 */
async function waitForRateLimit(provider: 'gemini' | 'groq'): Promise<void> {
  const redis = getRedis();
  const MAX_RPM = provider === 'groq' ? LLM_RATE_LIMIT.GROQ_RPM : LLM_RATE_LIMIT.GEMINI_RPM;

  while (true) {
    const minute = Math.floor(Date.now() / 60_000);
    const key    = `llm:rpm:${provider}:${minute}`;

    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60);

    if (count <= MAX_RPM) return;

    await redis.decr(key);
    logger.warn('LLM rate limit reached — waiting', { provider, count, MAX_RPM, waitMs: 2_000 });
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
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
  //         Braces inside string values (e.g. "use {city} here") must NOT
  //         count, so track whether we're inside a JSON string.
  let depth = 0;
  let endIndex = -1;
  let inString = false;
  let escaped  = false;
  for (let i = startIndex; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped)           escaped = false;
      else if (ch === '\\')  escaped = true;
      else if (ch === '"')   inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) { endIndex = i; break; }
    }
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

/**
 * Parses an LLM response that should be pure JSON. Schema-enforced Groq calls
 * return exactly the JSON document, so a plain JSON.parse is tried first and
 * is exact. Only if that fails do we fall back to extractJson(), which digs
 * the JSON out of surrounding text/fences.
 */
function parseJsonResponse<T>(raw: string, context: string): T {
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed !== null && typeof parsed === 'object') return parsed as T;
  } catch {
    /* not pure JSON — fall through to extraction */
  }
  return extractJson<T>(raw, context);
}

// ── Core Gemini call (fallback provider) ──────────────────────────────────
/**
 * Direct Gemini call — no fallback logic inside. callLLM() decides whether
 * to fall back here; this function just calls Gemini and throws on failure.
 */
async function callGeminiDirect(
  systemPrompt: string,
  userPrompt:   string,
  context:      string, // for logging — e.g. "business-profile:projectId"
): Promise<string> {
  const startedAt = Date.now();
  // Enforce global RPM limit across all workers
  await waitForRateLimit('gemini')
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
    const message     = err instanceof Error ? err.message : String(err);
    const isRateLimit   = message.includes('429') || message.toLowerCase().includes('rate limit');
    const isServerError = message.includes('500') || message.includes('503');

    logger.error(
      err instanceof Error ? err : new Error(message),
      { context, model: GEMINI_MODEL, durationMs, isRateLimit, isServerError },
    );

    throw err;
  }
}

// ── Core Groq call (primary provider) ─────────────────────────────────────
/**
 * Direct Groq call — no fallback logic inside. callLLM() decides whether
 * to fall back to Gemini; this function just calls Groq and throws on failure.
 */
/**
 * Per-call options. Defaults reproduce the previous behaviour exactly
 * (json_object mode, 8192 completion tokens, low reasoning effort).
 */
export interface LlmCallOptions {
  /**
   * When set, Groq enforces this JSON Schema with constrained decoding
   * (response_format json_schema, strict: true) — the response is guaranteed
   * to have exactly these keys and types, unless generation is cut off by the
   * token limit. Supported on openai/gpt-oss-20b and openai/gpt-oss-120b.
   */
  jsonSchema?:          { name: string; schema: Record<string, unknown> };
  maxCompletionTokens?: number;
  reasoningEffort?:     'low' | 'medium' | 'high';
}

type GroqJsonMode = 'schema' | 'json_object' | 'none';

async function callGroqDirect(
  systemPrompt: string,
  userPrompt:   string,
  context:      string,
  options:      LlmCallOptions = {},
): Promise<string> {
  const startedAt = Date.now();
  await waitForRateLimit('groq');

  logger.debug('Groq call started', {
    context,
    model:           GROQ_MODEL,
    systemPromptLen: systemPrompt.length,
    userPromptLen:   userPrompt.length,
    schemaEnforced:  !!options.jsonSchema,
  });

  const run = async (mode: GroqJsonMode): Promise<string> => {
    const groq = getGroq();

    let responseFormat: Record<string, unknown> | undefined;
    if (mode === 'schema' && options.jsonSchema) {
      responseFormat = {
        type: 'json_schema',
        json_schema: {
          name:   options.jsonSchema.name,
          strict: true,
          schema: options.jsonSchema.schema,
        },
      };
    } else if (mode === 'json_object') {
      responseFormat = { type: 'json_object' };
    }

    const params = {
      model:    GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      temperature:           0.3,
      max_completion_tokens: options.maxCompletionTokens ?? 8192,   // reasoning tokens count against this
      reasoning_effort:      options.reasoningEffort ?? 'low',      // gpt-oss: think less, answer sooner
      ...(responseFormat ? { response_format: responseFormat } : {}),
    };
    const completion = (await groq.chat.completions.create(params as any)) as Groq.Chat.ChatCompletion;
    return completion.choices[0]?.message?.content ?? '';
  };

  // Strictest mode first; relax only when Groq says the JSON could not be
  // produced/validated, or (schema mode only) rejects the schema request
  // itself. Rate limits and server errors are NOT retried here — they throw.
  const chain: GroqJsonMode[] = options.jsonSchema
    ? ['schema', 'json_object', 'none']
    : ['json_object', 'none'];

  try {
    let text = '';
    for (let i = 0; i < chain.length; i++) {
      try {
        text = await run(chain[i]);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const schemaRejected =
          chain[i] === 'schema' &&
          /\b400\b|invalid_request|response_format|json_schema/i.test(msg) &&
          !/\b429\b|rate limit/i.test(msg);
        const canRelax =
          i < chain.length - 1 && (msg.includes('json_validate_failed') || schemaRejected);
        if (!canRelax) throw err;

        logger.warn(`Groq ${chain[i]} mode failed — retrying with ${chain[i + 1]} mode`, {
          context,
          error: msg.slice(0, 300),
        });
        await waitForRateLimit('groq');
      }
    }

    if (!text || text.trim().length === 0) {
      throw new Error(`Groq returned empty response. Context: ${context}`);
    }

    logger.info('Groq call completed', {
      context,
      model:      GROQ_MODEL,
      durationMs: Date.now() - startedAt,
      outputLen:  text.length,
    });

    return text;

  } catch (err) {
    const message     = err instanceof Error ? err.message : String(err);
    const isRateLimit = message.includes('429') || message.toLowerCase().includes('rate limit');

    logger.error(
      err instanceof Error ? err : new Error(message),
      { context, model: GROQ_MODEL, durationMs: Date.now() - startedAt, isRateLimit },
    );
    throw err;
  }
}

// ── Public dispatcher — Groq primary, Gemini fallback ─────────────────────
/**
 * Base function — all LLM calls go through here.
 * Tries Groq first (primary). On Groq rate limit, falls back to Gemini
 * immediately instead of burning a BullMQ retry. Any other Groq error
 * (bad JSON, empty response, 5xx) propagates so BullMQ retries against
 * Groq again on the next attempt.
 *
 * Throws on:
 *   - 429 rate limit (both providers exhausted) → BullMQ retries
 *   - 5xx server error    → BullMQ retries
 *   - Empty response      → BullMQ retries
 *   - Invalid JSON        → BullMQ retries
 */
export async function callLLM(
  systemPrompt: string,
  userPrompt:   string,
  context:      string, // for logging — e.g. "business-profile:projectId"
  options:      LlmCallOptions = {},
): Promise<string> {
  try {
    return await callGroqDirect(systemPrompt, userPrompt, context, options);
  } catch (err) {
    const message     = err instanceof Error ? err.message : String(err);
    const isRateLimit = message.includes('429') || message.toLowerCase().includes('rate limit');

    if (isRateLimit) {
      logger.warn('Groq rate limited — falling back to Gemini', { context });
      return callGeminiDirect(systemPrompt, userPrompt, context);
    }

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
  linkTitles?:       Record<string, string>;
}

export interface GeoCitationLlmResponse {
  mentionedSources: Array<{
    name:    string;  // search result title
    domain?: string;  // domain, extracted from the real result URL
  }>;
  /** True if the search tool actually ran and returned results.
   *  False means the model answered from memory only (e.g. it judged
   *  search unnecessary) — 0 sources in that case doesn't mean "not
   *  cited," it means "we didn't actually check." Callers should treat
   *  that distinctly from a genuine zero-result search. */
  searchExecuted: boolean;
}

/**
 * Checks whether the project's domain shows up in REAL, live Google-web
 * search results Groq's compound-beta model runs server-side while
 * answering a realistic user query — not whether the model "remembers"
 * the domain from training data, and not the model's own self-reported
 * list of "sources it used" (which earlier versions of this function
 * relied on, and which an LLM can hallucinate).
 *
 * compound-beta autonomously decides whether to search; if it does, the
 * SDK exposes the actual executed_tools[].search_results — real URLs, not
 * LLM-generated ones — which is what we check the domain against.
 *
 * Used by: geo-analytics.job.ts
 *
 * ERROR HANDLING: throws on failure (rate limit, empty response, etc.) —
 * deliberately does NOT fall back to plain Gemini, since a Gemini fallback
 * would silently reintroduce non-grounded (memory-only) citation checking,
 * which defeats the point of this function. geo-analytics.job.ts already
 * treats a per-keyword failure here as non-fatal (failedPrompts++, continue
 * to next keyword) — that's the correct behavior on failure, not a silent
 * degrade to a different, weaker measurement.
 *
 * FUTURE: extend to ChatGPT + Perplexity for multi-provider GEO coverage.
 * FUTURE: send 2-3 query phrasing variants per keyword instead of one fixed
 *         template, to reduce undercounting from rigid query wording.
 */
export async function geoCitationCheck(
  userQuery: string,
  projectId: string,
  keyword:   string,
): Promise<GeoCitationLlmResponse> {
  const context   = `geo-citation:${projectId}:${keyword}`;
  const startedAt = Date.now();

  await waitForRateLimit('groq');

  logger.debug('Groq compound GEO citation check started', {
    context,
    model: GROQ_COMPOUND_MODEL,
  });

  try {
    const groq = getGroq();
    const completion = await groq.chat.completions.create({
      model:    GROQ_COMPOUND_MODEL,
      messages: [
        {
          role:    'system',
          content: 'You are a helpful AI assistant. Use web search to answer the user question naturally and helpfully, including specific website/business recommendations if relevant.',
        },
        { role: 'user', content: userQuery },
      ],
    });

    const message = completion.choices[0]?.message;

    if (!message) {
      throw new Error(`Groq compound returned no message. Context: ${context}`);
    }

    const executedTools  = message.executed_tools ?? [];
    const searchExecuted = executedTools.some(t => !!t.search_results);

    const mentionedSources: GeoCitationLlmResponse['mentionedSources'] = [];
    for (const tool of executedTools) {
      for (const result of tool.search_results?.results ?? []) {
        mentionedSources.push({
          name:   result.title ?? '',
          domain: safeExtractDomain(result.url),
        });
      }
    }

    logger.info('Groq compound GEO citation check completed', {
      context,
      durationMs:         Date.now() - startedAt,
      searchExecuted,
      searchResultCount:  mentionedSources.length,
    });

    return { mentionedSources, searchExecuted };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      err instanceof Error ? err : new Error(message),
      { context, model: GROQ_COMPOUND_MODEL, durationMs: Date.now() - startedAt },
    );
    throw err; // Deliberately no Gemini fallback — see function doc comment above.
  }
}

/** Extracts a bare hostname (no www., no protocol) from a URL string.
 *  Returns undefined if the URL is missing or unparseable. */
function safeExtractDomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

export interface SeoScoreLlmResponse {
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
  const context = `customer-profile:${projectId}`;
  const raw = await callLLM(
    PROMPTS.CUSTOMER_PROFILE_SYSTEM,
    PROMPTS.CUSTOMER_PROFILE_USER(siteUrl, crawledContent),
    context,
    { jsonSchema: { name: 'customer_profile', schema: CUSTOMER_PROFILE_JSON_SCHEMA } },
  );
  return parseJsonResponse<CustomerProfileLlmResponse>(raw, context);
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
  const raw = await callLLM(
    PROMPTS.KEYWORD_ALIGNMENT_SYSTEM(domainDescription),
    PROMPTS.KEYWORD_ALIGNMENT_USER(keywordList),
    `keyword-alignment:${projectId}`,
  );
  return extractJson<KeywordAlignmentLlmResponse>(raw, `keyword-alignment:${projectId}`);
}

export interface CompetitorVerificationLlmResponse {
  isCompetitor: boolean;
  reasoning:    string;
}

/**
 * Judges whether a candidate domain is plausibly a real competitor of the
 * business, based on the candidate's own crawled homepage content.
 *
 * Used by: competitor-discovery.job.ts — to verify user-entered and
 * AI-drafted competitor entries (which, unlike SERP-discovered ones, have
 * no external ground truth backing them). See
 * docs/05-phase4-competitor-discovery-audit.md for why this exists.
 *
 * On failure (LLM error, bad JSON), the caller should treat the entry as
 * unverified rather than dropping it — a failed check is not the same as
 * a negative judgment.
 */
export async function verifyCompetitor(
  businessDescription:   string,
  candidateDomain:       string,
  candidateTitle:        string,
  candidateDescription:  string,
  candidateTextSnippet:  string,
  projectId:             string,
): Promise<CompetitorVerificationLlmResponse> {
  const context = `competitor-verification:${projectId}:${candidateDomain}`;
  const raw = await callLLM(
    PROMPTS.COMPETITOR_VERIFICATION_SYSTEM,
    PROMPTS.COMPETITOR_VERIFICATION_USER(
      businessDescription, candidateDomain, candidateTitle, candidateDescription, candidateTextSnippet,
    ),
    context,
  );
  return extractJson<CompetitorVerificationLlmResponse>(raw, context);
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
  const raw = await callLLM(
    PROMPTS.SERP_ANALYSIS_SYSTEM(keyword, domainDescription),
    PROMPTS.SERP_ANALYSIS_USER(keyword, serpResults),
    `serp-analysis:${projectId}:${keyword}`,
  );
  return extractJson<SerpAnalysisLlmResponse>(raw, `serp-analysis:${projectId}:${keyword}`);
}

/**
 * Generates a full blog post for a keyword.
 * Used by: content-generation.job.ts (the live, actually-wired job —
 * deprecated/blog-generation.job.ts used this too before being
 * superseded; see deprecated/README.md)
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
  const raw = await callLLM(
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
  const raw = await callLLM(
    PROMPTS.MARKET_SIZING_SYSTEM,
    PROMPTS.MARKET_SIZING_USER(domainDescription, country),
    `market-sizing:${projectId}`,
  );
  return extractJson<MarketSizingLlmResponse>(raw, `market-sizing:${projectId}`);
}

/**
 * Audits a single page — generates all missing SEO fixes in one LLM call.
 * Used by: technical-audit.job.ts
 */
export async function auditPage(
  url:         string,
  title:       string,
  description: string,
  textContent: string,
  needs:       string[],
  imageSrcs:   string[],
  linkRefs:    Array<{ href: string; text: string }>,
  projectId:   string,
): Promise<PageAuditLlmResponse> {
  if (needs.length === 0) {
    logger.warn('auditPage called with empty needs list — returning empty', {
      projectId, url,
    });
    return {};
  }

  const context = `page-audit:${projectId}:${url}`;

  const raw = await callLLM(
    PROMPTS.PAGE_AUDIT_SYSTEM,
    PROMPTS.PAGE_AUDIT_USER(url, title, description, textContent, needs, imageSrcs, linkRefs),
    context,
  );

  return extractJson<PageAuditLlmResponse>(raw, context);
}
/**
 * Generates a one-sentence explanation of the mechanically-computed SEO
 * score for the project. The LLM does NOT invent its own score — it only
 * explains the deterministic weighted-pass-rate calculation it's given.
 * Used by: technical-audit.job.ts (once per audit run, not per page)
 */
export async function generateSeoScore(
  siteUrl:          string,
  actualScore:      number,
  totalPossible:    number,
  weightedPassRate: number,
  projectId:        string,
): Promise<SeoScoreLlmResponse> {
  const context = `seo-score:${projectId}`;

  const raw = await callLLM(
    PROMPTS.SEO_SCORE_SYSTEM,
    PROMPTS.SEO_SCORE_USER(siteUrl, actualScore, totalPossible, weightedPassRate),
    context,
  );

  return extractJson<SeoScoreLlmResponse>(raw, context);
}

export interface KnowledgeClassificationLlmResponse {
  classifiedDocumentKind:  'pricing' | 'case_study' | 'brand_guide' | 'general';
  classifiedUsageTags:     string[];
  classifiedAudience:      'B2B' | 'B2C' | 'Technical' | 'General';
  classifiedTrustLevel:    'HIGH' | 'MEDIUM' | 'LOW';
  classificationReasoning: string;
}

export interface UnderperformerAnalysisLlmResponse {
  type:       'ranking_drop' | 'high_impression' | 'competitor_update' | 'query_expansion' | 'content_gap';
  insight:    string;
  evidence:   string;
  category:   'content_structure' | 'keyword_density' | 'heading_structure' | 'content_length' | 'local_relevance' | 'content_freshness';
  confidence: number;
}

export interface BlogRewriteLlmResponse {
  title:                       string;
  slug:                        string;
  description:                 string;
  content:                     string;
  schema:                      Record<string, unknown>;
  contentOptimizationSummary:  string;
  seoTagOptimizationSummary:   string;
}


/**
 * Classifies an uploaded knowledge file — one LLM call per FILE, not per
 * chunk. See models/BlogLearning.ts (ProjectLearningChunk.classifiedTrustLevel
 * doc comment) for why: chunks from the same file denormalize this file-level
 * classification rather than each chunk getting its own classification call,
 * trading a small amount of precision (a 20-page doc could in theory mix
 * HIGH and LOW trust sections) for meaningfully lower cost — one call per
 * upload instead of one call per chunk.
 * Used by: knowledge-processing.job.ts
 */
export async function classifyKnowledgeFile(
  fileName:  string,
  textSample: string,
  projectId: string,
  fileId:    string,
): Promise<KnowledgeClassificationLlmResponse> {
  const context = `knowledge-classify:${projectId}:${fileId}`;

  const raw = await callLLM(
    PROMPTS.KNOWLEDGE_CLASSIFICATION_SYSTEM,
    PROMPTS.KNOWLEDGE_CLASSIFICATION_USER(fileName, textSample),
    context,
  );

  return extractJson<KnowledgeClassificationLlmResponse>(raw, context);
}

/**
 * Diagnoses why an underperforming blog is underperforming by comparing it
 * directly against the pages currently outranking it. Produces one
 * structured insight — the same shape BlogLearning already stores, this
 * function just replaces the previous purely-metric-based detectInsights()
 * heuristic (gsc-monitor.job.ts) with an LLM call grounded in actual
 * competitor page content for cases where a rewrite is being considered.
 * Used by: blog-optimization.job.ts
 */
export async function analyzeUnderperformer(
  keyword:         string,
  ourContent:      string,
  gscSummary:      string,
  competitorPages: Array<{ url: string; content: string }>,
  projectId:       string,
  blogId:          string,
): Promise<UnderperformerAnalysisLlmResponse> {
  const context = `underperformer-analysis:${projectId}:${blogId}`;

  const raw = await callLLM(
    PROMPTS.SERP_COMPARATIVE_ANALYSIS_SYSTEM,
    PROMPTS.SERP_COMPARATIVE_ANALYSIS_USER(keyword, ourContent, gscSummary, competitorPages),
    context,
  );

  return extractJson<UnderperformerAnalysisLlmResponse>(raw, context);
}

/**
 * Rewrites an underperforming blog post, applying retrieved learnings and
 * brand-knowledge context. Structurally similar to generateBlogPost() but
 * takes the EXISTING content as input (to rewrite, not replace from
 * scratch) and a learnings block instead of fresh SERP analysis.
 * Used by: blog-optimization.job.ts
 */
export async function rewriteBlogPost(
  currentContent:   string,
  customerProfile:  string,
  keyword:          string,
  knowledgeChunks:  string,
  learningsContext: string,
  contactUrl:       string,
  projectId:        string,
  blogId:           string,
): Promise<BlogRewriteLlmResponse> {
  const context = `blog-rewrite:${projectId}:${blogId}`;

  const raw = await callLLM(
    PROMPTS.BLOG_REWRITE_SYSTEM(customerProfile, keyword, knowledgeChunks, learningsContext, contactUrl),
    PROMPTS.BLOG_REWRITE_USER(currentContent),
    context,
  );

  return extractJson<BlogRewriteLlmResponse>(raw, context);
}

// ── Competitor relevance (region + scale) ──────────────────────────────────

export interface CompetitorRelevanceResponse {
  verdicts?: Array<{ domain?: string; verdict?: string; reason?: string }>;
}

/**
 * ONE batched call that judges whether SERP-found domains are realistic
 * competitors for the business, from titles and snippets only (no crawling).
 * Light task: low reasoning effort, small completion budget.
 */
export async function judgeCompetitorCandidates(
  businessDescription: string,
  targetRegions:       string[],
  candidates:          Array<{ domain: string; title: string; snippet: string }>,
  projectId:           string,
): Promise<CompetitorRelevanceResponse> {
  const context = `competitor-relevance:${projectId}`;
  const raw = await callLLM(
    COMPETITOR_RELEVANCE_SYSTEM,
    COMPETITOR_RELEVANCE_USER(businessDescription, targetRegions, candidates),
    context,
    {
      jsonSchema:          { name: 'competitor_relevance', schema: COMPETITOR_RELEVANCE_JSON_SCHEMA },
      maxCompletionTokens: 4096,
      reasoningEffort:     'low',
    },
  );
  return parseJsonResponse<CompetitorRelevanceResponse>(raw, context);
}
