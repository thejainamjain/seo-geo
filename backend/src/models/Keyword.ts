/**
 * models/Keyword.ts
 *
 * WHO: A keyword being tracked or targeted for a project.
 * Keywords feed the content strategy — each keyword can have one Blog
 * generated for it. Keywords are discovered via DataForSEO or SerpAPI,
 * or added manually by the user.
 *
 * WHY SEPARATE COLLECTION: Keywords are queried independently in the
 * "Keywords & Content" view — filtered by status, week number, search volume.
 * They also exist before a Blog is created (status: "upcoming") and
 * sometimes without a Blog at all (user rejected the content suggestion).
 * Embedding in Project would make these queries painful and the array
 * grows unboundedly.
 *
 * LIFECYCLE:
 *   upcoming   → keyword discovered, no content started
 *   generating → user clicked Generate — SERP + blog LLM calls in progress
 *   draft      → blog written by AI, awaiting review
 *   ready      → blog approved, ready to publish
 *   published  → blog live on CMS
 *
 * DATA SOURCES:
 *   DataForSEO — search volume, difficulty, CPC (use Sandbox in dev — free)
 *   SerpAPI    — SERP analysis, related questions, People Also Ask
 *   AI         — relevance scoring, keyword pillar grouping
 */

import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IKeyword extends Document {
  projectId: Types.ObjectId;

  keyword:       string;
  searchVolume?: number;   // Monthly searches from DataForSEO
  difficulty?:   number;   // 0–100 SEO difficulty score
  cpc?:          number;   // Cost per click in USD (DataForSEO)

  /**
   * Lifecycle status:
   * upcoming   → Queued, no content started yet
   * generating → Generate button clicked — SERP + blog in progress
   * draft      → Blog written by AI, awaiting user review
   * ready      → Blog approved, awaiting publish
   * published  → Blog is live on the site
   */
  status: 'upcoming' | 'generating' | 'draft' | 'ready' | 'published';

  /** Which week in the content calendar this keyword is scheduled for */
  weekNumber?: number;

  /** Start date of the scheduled week */
  startDate?: Date;

  /**
   * Keyword pillar this belongs to — groups related keywords together.
   * e.g. "seo_basics", "local_seo", "technical_seo"
   */
  pillar?: string;

  /** AI-generated explanation of why this keyword was selected */
  relevanceReason?: string;

  /** What type of page should target this keyword */
  pageType?: 'blog' | 'landing_page' | 'product' | 'comparison';

  /**
   * How this keyword was discovered:
   * "ai_suggested" → our AI recommended it based on business context
   * "user_added"   → user manually added it
   * "gsc_import"   → imported from Google Search Console
   * "dataforseo"   → from DataForSEO keyword research
   */
  source: 'ai_suggested' | 'user_added' | 'gsc_import' | 'dataforseo';

  /** Alignment score: how well this keyword matches the business (0–100) */
  alignmentScore?: number;

  /** AI-generated content brief for this keyword (JSON string from SERP analysis) */
  brief?: string;

  /**
   * Draft blog title suggested at keyword-discovery time (from
   * generateMarketSizing()'s per-keyword title field, previously computed
   * and discarded — see workers/jobs/keyword-research.job.ts). Distinct
   * from the Blog document's own title, which is generated fresh once
   * content generation actually runs and can differ from this suggestion.
   * Purely a "here's roughly what this will become" preview for the UI.
   */
  suggestedTitle?: string;

  createdAt: Date;
  updatedAt: Date;
}

const KeywordSchema = new Schema<IKeyword>(
  {
    projectId:    { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    keyword:      { type: String, required: true, trim: true },
    searchVolume: { type: Number },
    difficulty:   { type: Number, min: 0, max: 100 },
    cpc:          { type: Number },
    status: {
      type:    String,
      enum:    ['upcoming', 'generating', 'draft', 'ready', 'published'],
      default: 'upcoming',
    },
    weekNumber: { type: Number },
    startDate:  { type: Date },
    pillar:     { type: String },
    relevanceReason: { type: String },
    pageType: {
      type:    String,
      enum:    ['blog', 'landing_page', 'product', 'comparison'],
      default: 'blog',
    },
    source: {
      type:    String,
      enum:    ['ai_suggested', 'user_added', 'gsc_import', 'dataforseo'],
      default: 'ai_suggested',
    },
    alignmentScore: { type: Number, min: 0, max: 100 },
    brief:          { type: String },
    suggestedTitle: { type: String },
  },
  { timestamps: true },
);

KeywordSchema.index({ projectId: 1, status: 1 });
KeywordSchema.index({ projectId: 1, weekNumber: 1 });
KeywordSchema.index({ projectId: 1, pillar: 1 });

export const Keyword = mongoose.model<IKeyword>('Keyword', KeywordSchema);

