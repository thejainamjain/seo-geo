export const PROMPTS = {
  BLOG_GENERATION_SYSTEM: (customerProfile: string, keyword: string, sourceAnalysis: string, knowledgeChunks: string, contactUrl: string) => {
    // The model has no clock — without this it fills years in from its
    // training data (titles came out as "(2024)"). Computed per call.
    const now   = new Date();
    const year  = now.getFullYear();
    const today = now.toISOString().slice(0, 10);

    return `You are an expert content writer producing SEO-optimized blog posts. Write the article body in HTML.

  Today's date: ${today}. The current year is ${year}. Use ${year} for anything date-related. Never present an earlier year as the current year.

  Business context: ${customerProfile}
  Target keyword: ${keyword}
  SERP analysis: ${sourceAnalysis}
  Brand knowledge: ${knowledgeChunks}

  Rules:
  - Title: write a natural, specific title a real person would want to click, ideally 50-65 characters. Build it around the main topic of the target keyword and mention the location only where it reads naturally. Keywords are often long or ungrammatical, so rephrase them instead of pasting them in word for word. A numbered list title (for example "7 Best ...") is fine when the post really is a list. For "best", "top", comparison or guide-style titles, end the title with (${year}). Never use any other year.
  - Start with <h1>{title}</h1>
  - Then <h2>TL;DR</h2> summary
  - Then <hr> and intro paragraph with CTA link to ${contactUrl}
  - Then main sections with h2/h3 headings, lists, local pricing
  - Include at least 2 citations with rel="nofollow"
  - Length: 1,500 to 2,000 words
  - Do NOT mention AI

  Return ONLY valid JSON:
  {
    "title": "string",
    "slug": "url-friendly-slug",
    "description": "meta description 150-160 chars",
    "content": "<full HTML>"
  }`;
  },

  BLOG_GENERATION_USER: (keyword: string) =>
    `Write a comprehensive SEO blog post targeting the keyword: "${keyword}"`,

  SERP_ANALYSIS_SYSTEM: (keyword: string, domainDescription: string) =>
    `You are an SEO analyst. Analyze these SERP results for the keyword "${keyword}". Return ONLY valid JSON, no markdown.

  Business: ${domainDescription}

  Schema:
  {
    "serpRelevance": [
      {
        "title": "string",
        "topic": "string",
        "link": "string",
        "pageType": "blog",
        "titleIntentReasoning": "string",
        "titleIntent": "informational",
        "contentAboutCompetitorReasoning": "string",
        "contentAboutCompetitor": false,
        "contentAboutCompetitorAlternativesOrReview": false,
        "businessRelevanceReasoning": "string",
        "isRelevantToBusiness": true,
        "icpRelevanceReasoning": "string",
        "isRelevantToICP": true
      }
    ]
  }`,

  SERP_ANALYSIS_USER: (keyword: string, serpResults: string) =>
    `Keyword: ${keyword}\nSERP results:\n${serpResults}`,

  KEYWORD_ALIGNMENT_SYSTEM: (domainDescription: string) =>
    `You are a keyword strategist. Score each keyword's alignment to this business. Return ONLY valid JSON, no markdown.

  Business: ${domainDescription}

  Schema:
  {
    "keywords": [
      {
        "keyword": "string",
        "reasoning": "compelling one-sentence user-facing reason why this keyword matters",
        "relevant": true,
        "alignmentScore": 85
      }
    ]
  }`,

  KEYWORD_ALIGNMENT_USER: (keywordList: string) =>
    `Score these keywords for the business above:\n${keywordList}`,

  COMPETITOR_VERIFICATION_SYSTEM: `You are a market research analyst. You'll be given a business description and a candidate competitor's homepage content. Decide whether this candidate is plausibly a real competitor — i.e. serves a similar customer need, in a similar market, not just a coincidental keyword overlap (e.g. a news article that happens to mention a similar topic is NOT a competitor). Return ONLY valid JSON, no markdown, no explanation.

Schema:
{
  "isCompetitor": true,
  "reasoning": "one sentence explaining the judgment"
}`,

  COMPETITOR_VERIFICATION_USER: (
    businessDescription: string,
    candidateDomain:     string,
    candidateTitle:      string,
    candidateDescription: string,
    candidateTextSnippet: string,
  ) =>
    `Business being analyzed:\n${businessDescription}\n\nCandidate competitor: ${candidateDomain}\nPage title: ${candidateTitle}\nPage description: ${candidateDescription}\nPage content snippet:\n${candidateTextSnippet.slice(0, 1_000)}\n\nIs this candidate a real competitor of the business above?`,

  CUSTOMER_PROFILE_SYSTEM: `You are a senior business strategist. Analyze this website deeply and return a comprehensive customer profile JSON object. Return ONLY valid JSON, no markdown, no explanation.

  CRITICAL: Every single value in the JSON must be a plain string. No arrays. No objects. No nested structures anywhere.
  Use newlines within strings to separate multiple items (e.g. "item1\nitem2\nitem3").
  For pricing: write as plain text like "Free plan: basic features. Pro: $29/mo with advanced features."
  Never use null and never omit a key.
  Facts the content does not state (pricing, lifetime value, case studies, proof, social links, discussions): use an empty string rather than inventing them.
  Strategic fields (MainCompetitors, Differentiation, UniqueStrengths, TradeOffsYouAccept): do NOT leave these empty. Write your best specific draft from what the content shows about how the business positions itself, who it serves and what it emphasizes. They are drafts for the owner to edit, so keep each to a few short sentences or newline-separated points, and never invent awards, customers, statistics or claims the content does not support. For MainCompetitors list domains of realistic competitors for this kind of business in its region.

  Schema:
  {
    "CompanyName": "string",
    "Website": "string",
    "TargetRegionsOrLanguages": "comma-separated string e.g. India, United States",
    "ProductOrService": {
      "WhatTheBusinessSells": "one sentence string",
      "KeyFeaturesAndBenefits": "newline-separated string e.g. Feature 1: benefit\\nFeature 2: benefit",
      "ProductTiersAndInclusions": "plain text string e.g. Free: basic access. Pro: $29/mo full access.",
      "FreeTrialOrDemoAvailability": "string that MUST start with exactly 'Yes' or 'No', followed by details, e.g. 'Yes, 14-day free trial' or 'No free trial, but a demo is available on request'",
      "TotalLifetimeValuePerClient": "string"
    },
    "TargetCustomers": {
      "CustomerSegments": "newline-separated string e.g. Freelancers\\nSmall business owners\\nEntrepreneurs",
      "CustomerPainPoints": "newline-separated string e.g. Finding clients\\nHigh commission fees",
      "KeywordsTheyTalkAbout": "newline-separated string e.g. freelancing\\ndesign tools\\nportfolio",
      "TopUseCasesYouWantToRankFor": "newline-separated string e.g. freelance platform\\ncommission-free work"
    },
    "CompetitorsAndDifferentiation": {
      "MainCompetitors": "newline-separated string of domains e.g. upwork.com\\nfiverr.com\\ntoptal.com",
      "Differentiation": "string",
      "UniqueStrengths": "string",
      "Proof": "string",
      "TradeOffsYouAccept": "string"
    },
    "SocialProofAndTrust": {
      "CaseStudies": "string",
      "OrganicDiscussions": "string",
      "SocialMediaPresence": "string"
    }
  }`,

  CUSTOMER_PROFILE_USER: (url: string, crawledContent: string) =>
  `Website URL: ${url}\nCrawled content:\n${crawledContent.slice(0, 12000)}`,

  SEO_SCORE_SYSTEM: `You are a technical SEO analyst. You will be given a website's mechanically-computed SEO score, derived from real technical checks (title tags, meta descriptions, alt text, broken links, schema markup, page speed, etc.) run against every crawled page. The score itself is already final — your only job is to explain it in one sentence, grounded in the numbers you're given (e.g. what the weighted pass rate implies, roughly how many checks passed vs failed). Do not propose a different score. Do not factor in brand reputation, fame, or inferred traffic — this is a technical audit, not a brand-authority rating.
  Return ONLY a JSON object: { "reasoning": "<one sentence>" }`,

  SEO_SCORE_USER: (url: string, actualScore: number, totalPossible: number, weightedPassRate: number) =>
    `Website: ${url}\nMechanical SEO score: ${actualScore} out of ${totalPossible}\nWeighted pass rate: ${weightedPassRate.toFixed(1)}%\n\nExplain this score in one sentence.`,

  MARKET_SIZING_SYSTEM: `You are an SEO market sizing expert. Analyze this business and generate 20 initial target keywords with estimated traffic data. Return ONLY valid JSON, no markdown, no explanation.

Schema:
{
  "keywords": [
    {
      "title": "Full SEO blog post title",
      "keyword": "target keyword phrase",
      "difficulty": 28,
      "search_volume": 250
    }
  ],
  "calculations": "Step by step market sizing reasoning",
  "totalSearchVolume": 22860000,
  "marketCountryAlpha3": "ind"
}`,

  MARKET_SIZING_USER: (domainDescription: string, country: string) =>
    `Business profile:\n${domainDescription}\n\nPrimary market country: ${country}\n\nGenerate 20 target keywords with realistic search volumes and difficulty scores.`,

  PAGE_AUDIT_SYSTEM: `You are a technical SEO specialist. You will receive a webpage's content and a list of what needs to be fixed or generated. Return ONLY a valid JSON object with exactly the fields requested. No markdown, no explanation, no extra fields.

Rules:
- title: 50-60 chars, include primary keyword naturally, do not keyword-stuff
- description: 150-160 chars, compelling, includes keyword, ends with implicit CTA
- ogTitle: same as title or slight variation for social sharing
- ogDescription: 120-140 chars, conversational, shareable
- altTexts: object mapping image src to descriptive alt text — describe what the image shows, include keyword only if natural
- schema: valid Schema.org JSON-LD object appropriate for the page type (Article, LocalBusiness, Product, FAQPage, WebPage). Must include @context and @type
- faqQuestions: 3-5 Q&A pairs a user would actually ask about this page's topic. Each answer 2-4 sentences. Must be answerable from page content
- tldrText: 2-3 sentence plain-text summary of the page's key point — what a user gets from visiting this page
- brokenLinkFix: one sentence suggesting anchor text replacement or noting the link should be removed
- contentExpansion: 2-3 bullet topics that would expand this page's thin content
- redirectFix: one sentence explaining which internal links should be updated to point to the final URL
- h1Suggestion: a compelling H1 tag (60-70 chars, includes primary keyword)
- schemaFix: one sentence listing the missing schema fields and suggested values
- speedFix: 2-3 specific actionable suggestions to reduce page load time
- canonicalFix: one sentence explaining the canonical mismatch and the correct canonical URL
- pageSizeFix: one sentence identifying what's making the page large and how to reduce it
- linkTitles: object mapping link href to a short descriptive title attribute (3-8 words). For links with visible anchor text, base the title on that text and the link's destination. For links with empty or generic anchor text (icon-only social links, "click here"), infer purpose from the domain (e.g. instagram.com → "Follow us on Instagram", whatsapp.com → "Chat with us on WhatsApp", x.com/twitter.com → "Follow us on X")`,

  PAGE_AUDIT_USER: (
      url:         string,
      title:       string,
      description: string,
      textContent: string,
      needs:       string[],
      imageSrcs:   string[],
      linkRefs:    Array<{ href: string; text: string }> = [],
    ) => {
      const needsList = needs.join(', ');
      const imgBlock  = imageSrcs.length > 0
        ? `\nImages needing alt text:\n${imageSrcs.map(s => `- ${s}`).join('\n')}`
        : '';
      const linkBlock = linkRefs.length > 0
        ? `\nLinks needing title attributes:\n${linkRefs.map(l => `- href: ${l.href}, current text: "${l.text || '(empty)'}"`).join('\n')}`
        : '';

      return `Page URL: ${url}
  Current title: ${title || '(missing)'}
  Current description: ${description || '(missing)'}
  Page content (truncated):
  ${textContent.slice(0, 8_000)}
  ${imgBlock}
  ${linkBlock}

  Generate ONLY these fields: ${needsList}
  Return a single JSON object with only those keys.`;
    },

  // ── Knowledge & Learning System ───────────────────────────────────────────
  // See LEARNING_SYSTEM_ARCHITECTURE.md and docs/13-knowledge-learning-system.md

  KNOWLEDGE_CLASSIFICATION_SYSTEM: `You are classifying an uploaded business document so it can be retrieved correctly later. Read the document text and classify it. Return ONLY valid JSON, no markdown, no explanation.

Schema:
{
  "classifiedDocumentKind": "pricing" | "case_study" | "brand_guide" | "general",
  "classifiedUsageTags": ["short-tag-1", "short-tag-2"],
  "classifiedAudience": "B2B" | "B2C" | "Technical" | "General",
  "classifiedTrustLevel": "HIGH" | "MEDIUM" | "LOW",
  "classificationReasoning": "one sentence explaining the trust level judgment"
}

Guidance:
- classifiedDocumentKind drives HOW the document gets chunked later (a pricing doc's tables are extracted differently than a case study's narrative sections) — pick the single best-fitting category, default to "general" if none clearly fit.
- classifiedTrustLevel: HIGH for official pricing/product facts and named case studies with real numbers; MEDIUM for general brand voice/style guides; LOW for anything that reads like a draft, placeholder, or contains contradictory/unclear information.`,

  KNOWLEDGE_CLASSIFICATION_USER: (fileName: string, textSample: string) =>
    `Document filename: ${fileName}\n\nDocument text (may be truncated):\n${textSample.slice(0, 6_000)}\n\nClassify this document.`,

  SERP_COMPARATIVE_ANALYSIS_SYSTEM: `You are an SEO analyst diagnosing why a published blog post is underperforming, by comparing it directly against the pages currently ranking above it. Return ONLY valid JSON, no markdown, no explanation.

Schema:
{
  "type": "ranking_drop" | "high_impression" | "competitor_update" | "query_expansion" | "content_gap",
  "insight": "plain-English description of what to do differently, specific enough to act on",
  "evidence": "specific proof from the competitor pages that supports this insight",
  "category": "content_structure" | "keyword_density" | "heading_structure" | "content_length" | "local_relevance" | "content_freshness",
  "confidence": 0.0 to 1.0
}

Guidance:
- Ground the insight in a concrete, observable difference between our page and the top-ranking competitor pages (a structural element they have that we don't, a topic they cover that we don't, a format difference) — not a generic "improve content quality" statement.
- confidence should reflect how consistently the pattern appears across the competitor pages provided (seen in all of them = high confidence; seen in only one = lower).`,

  SERP_COMPARATIVE_ANALYSIS_USER: (
    keyword:            string,
    ourContent:         string,
    gscSummary:         string,
    competitorPages:    Array<{ url: string; content: string }>,
  ) => {
    const competitorBlock = competitorPages
      .map((p, i) => `--- Competitor ${i + 1}: ${p.url} ---\n${p.content.slice(0, 4_000)}`)
      .join('\n\n');

    return `Target keyword: ${keyword}\n\nOur current performance:\n${gscSummary}\n\nOur current blog content:\n${ourContent.slice(0, 6_000)}\n\nCurrently ranking above us:\n${competitorBlock}\n\nWhat specifically are the ranking pages doing better? Produce one structured insight.`;
  },

  BLOG_REWRITE_SYSTEM: (
    customerProfile:  string,
    keyword:          string,
    knowledgeChunks:  string,
    learningsContext: string,
    contactUrl:       string,
  ) => `You are rewriting an underperforming blog post to apply specific, evidence-backed improvements while keeping everything that already works. Return ONLY valid JSON, no markdown, no explanation.

${customerProfile}

Target keyword: ${keyword}
Contact/CTA URL: ${contactUrl}

${knowledgeChunks ? `--- BRAND CONTEXT ---\n${knowledgeChunks}\n--- END BRAND CONTEXT ---\n` : ''}
${learningsContext}

Apply every HIGH-confidence learning above. Consider MEDIUM-confidence learnings where they don't conflict. Do not apply anything not backed by a learning or brand context — don't invent new claims, pricing, or statistics.

Schema:
{
  "title": "string",
  "slug": "string",
  "description": "string (meta description)",
  "content": "string (full HTML)",
  "schema": { ...JSON-LD structured data... },
  "contentOptimizationSummary": "plain-English summary of what changed in the body content and why, referencing which learnings drove each change",
  "seoTagOptimizationSummary": "plain-English summary of what changed in title/meta/schema and why"
}`,

  BLOG_REWRITE_USER: (currentContent: string) =>
    `Current blog content to rewrite:\n\n${currentContent}`,
}

// ── JSON schemas (enforced by Groq constrained decoding) ───────────────────
// Strict mode requires every property to be listed in `required` and
// additionalProperties:false at every level. Every profile value is a plain
// string (the prompt says so), so the schema is built from key lists — an
// unknown value is "" rather than a missing key or null.
function strictStringObject(keys: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(keys.map(k => [k, { type: 'string' }])),
    required: keys,
    additionalProperties: false,
  };
}

export const CUSTOMER_PROFILE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    CompanyName:              { type: 'string' },
    Website:                  { type: 'string' },
    TargetRegionsOrLanguages: { type: 'string' },
    ProductOrService: strictStringObject([
      'WhatTheBusinessSells',
      'KeyFeaturesAndBenefits',
      'ProductTiersAndInclusions',
      'FreeTrialOrDemoAvailability',
      'TotalLifetimeValuePerClient',
    ]),
    TargetCustomers: strictStringObject([
      'CustomerSegments',
      'CustomerPainPoints',
      'KeywordsTheyTalkAbout',
      'TopUseCasesYouWantToRankFor',
    ]),
    CompetitorsAndDifferentiation: strictStringObject([
      'MainCompetitors',
      'Differentiation',
      'UniqueStrengths',
      'Proof',
      'TradeOffsYouAccept',
    ]),
    SocialProofAndTrust: strictStringObject([
      'CaseStudies',
      'OrganicDiscussions',
      'SocialMediaPresence',
    ]),
  },
  required: [
    'CompanyName',
    'Website',
    'TargetRegionsOrLanguages',
    'ProductOrService',
    'TargetCustomers',
    'CompetitorsAndDifferentiation',
    'SocialProofAndTrust',
  ],
  additionalProperties: false,
};

// ── Competitor relevance (region + scale) ──────────────────────────────────

export const COMPETITOR_RELEVANCE_SYSTEM = `You decide whether websites that appeared in search results are realistic competitors of one specific business.

Judge each candidate on three things:
1. Offering: does it sell the same kind of product or service to the same kind of customer?
2. Geography: does it serve the business's target regions? A site clearly aimed at a different country or market is not a competitor there.
3. Scale: is it comparable in reach to the business? A national or global marketplace, retail chain or large brand is not a realistic competitor for a small local business.

Verdicts:
- "competitor": plausibly competes for the same customers.
- "not_comparable": clearly a different kind of business, a different market, or a scale that makes it no realistic competitor. Use this only when the title and snippet make that reasonably clear.
- "unsure": the title and snippet are not enough to tell. Prefer this over guessing.

Judge only from the business description and each candidate's title and snippet. Do not rely on the domain name alone and do not invent facts about a site. Keep each reason to one short sentence.`;

export function COMPETITOR_RELEVANCE_USER(
  businessDescription: string,
  targetRegions:       string[],
  candidates:          Array<{ domain: string; title: string; snippet: string }>,
): string {
  const list = candidates
    .map((c, i) => `${i + 1}. domain: ${c.domain}\n   title: ${c.title || '(none)'}\n   snippet: ${c.snippet || '(none)'}`)
    .join('\n');

  return `BUSINESS:
${businessDescription}

TARGET REGIONS: ${targetRegions.length > 0 ? targetRegions.join(', ') : 'not specified'}

CANDIDATE WEBSITES (from search results):
${list}

Return one verdict for EVERY candidate, using its domain exactly as written.`;
}

export const COMPETITOR_RELEVANCE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          domain:  { type: 'string' },
          verdict: { type: 'string', enum: ['competitor', 'not_comparable', 'unsure'] },
          reason:  { type: 'string' },
        },
        required: ['domain', 'verdict', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
};

// ── Blog generation JSON schema ────────────────────────────────────────────
// The article schema (JSON-LD) is deliberately NOT requested from the model:
// it is injected into every CMS post, so lib/llm.ts builds it in code from the
// title and description instead of trusting free-form model output.
export const BLOG_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    title:       { type: 'string' },
    slug:        { type: 'string' },
    description: { type: 'string' },
    content:     { type: 'string' },
  },
  required: ['title', 'slug', 'description', 'content'],
  additionalProperties: false,
};
