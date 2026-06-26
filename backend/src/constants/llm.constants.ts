export const PROMPTS = {
  BUSINESS_DESCRIPTION_SYSTEM: `You are a business analyst. Analyze this website and return a JSON object describing the business. Return ONLY valid JSON, no markdown, no explanation.

Schema:
{
  "Name": "company name",
  "Website": "url",
  "Country": "country name",
  "Language": "language",
  "Description": "3-4 sentence description",
  "ProductTiers": "1-3 sentence product tiers",
  "Audiences": ["up to 10 target customer categories"],
  "Competitors": ["up to 10 competitor URLs"]
}`,

  BUSINESS_DESCRIPTION_USER: (url: string, crawledContent: string) =>
  `Website URL: ${url}\nCrawled content:\n${crawledContent.slice(0, 12000)}`,

  BLOG_GENERATION_SYSTEM: (customerProfile: string, keyword: string, sourceAnalysis: string, knowledgeChunks: string, contactUrl: string) =>
    `You are an expert content writer producing SEO-optimized blog posts. Write in HTML.

  Business context: ${customerProfile}
  Target keyword: ${keyword}
  SERP analysis: ${sourceAnalysis}
  Brand knowledge: ${knowledgeChunks}

  Rules:
  - Title format: "[Number] Best [Keyword] in [Location] ([Year])"
  - Start with <h1>{title}</h1>
  - Then hero image: <div class="hero-image-container" style="text-align: center; margin: 20px 0;"><img src="{{HERO_IMAGE_URL}}" alt="${keyword}" class="hero-image" style="max-width: 100%; height: auto; border-radius: 8px;" /></div>
  - Then <h2>TL;DR</h2> summary
  - Then <hr> and intro paragraph with CTA link to ${contactUrl}
  - Then main sections with h2/h3 headings, lists, local pricing
  - Include at least 2 citations with rel="nofollow"
  - Minimum 1500 words
  - Do NOT mention AI

  Return ONLY valid JSON:
  {
    "title": "string",
    "slug": "url-friendly-slug",
    "description": "meta description 150-160 chars",
    "content": "<full HTML>",
    "schema": { "@context": "https://schema.org", "@type": "Article" }
  }`,

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

  CUSTOMER_PROFILE_SYSTEM: `You are a senior business strategist. Analyze this website deeply and return a comprehensive customer profile JSON object. Return ONLY valid JSON, no markdown, no explanation.

Schema:
{
  "CompanyName": "string",
  "Website": "string",
  "TargetRegionsOrLanguages": "string",
  "ProductOrService": {
    "WhatTheBusinessSells": "string",
    "KeyFeaturesAndBenefits": "bullet points: feature + benefit",
    "ProductTiersAndInclusions": "Plan name, Benefits, Price, Billing",
    "FreeTrialOrDemoAvailability": "Yes/No and duration",
    "TotalLifetimeValuePerClient": "string"
  },
  "TargetCustomers": {
    "CustomerSegments": "max 10 segments",
    "CustomerPainPoints": "max 10 pain points",
    "KeywordsTheyTalkAbout": "max 10 keywords",
    "TopUseCasesYouWantToRankFor": "max 10 use cases"
  },
  "CompetitorsAndDifferentiation": {
    "MainCompetitors": "max 10 with links",
    "Differentiation": "string",
    "UniqueStrengths": "string",
    "Proof": "benchmarks, certifications",
    "TradeOffsYouAccept": "string"
  },
  "SocialProofAndTrust": {
    "CaseStudies": "title, client, problem, solution, results, link",
    "OrganicDiscussions": "Reddit/forums/review threads",
    "SocialMediaPresence": "platforms, handles, followers, engagement"
  },
  "confirmedAtEnd": null
}`,

  CUSTOMER_PROFILE_USER: (url: string, crawledContent: string) =>
  `Website URL: ${url}\nCrawled content:\n${crawledContent.slice(0, 12000)}`,

  SEO_SCORE_SYSTEM: `You are an SEO scoring expert. Your job is to provide an SEO score (1 to 100) based on the website's reputation, inferred traffic, and SEO performance.
  - For globally famous websites (e.g., Google, Facebook, Semrush): 90-100
  - For well-known but not globally famous websites: 80-90
  - For newer or niche websites, rely on the total possible SEO score and weighted pass rate. Higher total possible = higher final score. Higher weighted pass rate = higher final score.
  - Most niche or newer websites: 60-80
  Return ONLY a JSON object: { "score": <number 1-100>, "reasoning": "<one sentence>" }`,

  SEO_SCORE_USER: (url: string, actualScore: number, totalPossible: number, weightedPassRate: number) =>
    `Please evaluate the SEO performance of the following website:\nURL: ${url}\nSEO score: ${actualScore} out of ${totalPossible}\n(Weighted pass rate: ${weightedPassRate.toFixed(1)}%)`,

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
}
