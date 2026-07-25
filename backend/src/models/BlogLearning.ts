/**
 * models/BlogLearning.ts
 *
 * WHO: AI-generated insights derived from GSC performance data for a blog post.
 * After a blog is published and starts getting impressions/clicks in GSC,
 * the system analyzes performance and generates "learnings" — insights about
 * what's working and what should be changed in the next re-optimization.
 *
 * WHY SEPARATE COLLECTION: Written asynchronously by a background job
 * after GSC data comes in. Multiple learnings per blog. Queried independently
 * for the re-optimization pipeline. Not needed at blog load time.
 *
 * ADVANCED FEATURE: Build after the basic blog generation pipeline works.
 * This is what makes the content loop self-improving over time.
 *
 * FLOW: Blog published → GSC collects data → weekly job runs →
 *       Gemini analyzes GSC snapshot + content → creates BlogLearning docs →
 *       BlogOptimization job uses these to rewrite the blog
 */

import mongoose, { Document, Schema, Types } from "mongoose";

export interface IBlogLearning extends Document {
  blogId: Types.ObjectId;
  projectId: Types.ObjectId;

  /**
   * Type of insight:
   * "ranking_drop"      → Blog lost rankings, content may be stale
   * "high_impression"   → Getting seen but low clicks — title/meta issue
   * "competitor_update" → Competitor published better content on same keyword
   * "query_expansion"   → New related queries appearing in GSC for this post
   * "content_gap"       → Users asking questions the blog doesn't answer
   */
  type: string;

  insight: string;        // Plain-language description of what was learned
  evidence: string;       // What data supports this insight
  category: string;       // e.g. "seo", "content", "technical"
  confidence: number;     // 0–1 confidence score from the AI

  /** The GSC metrics snapshot that triggered this learning */
  gscSnapshot?: {
    clicks: number;
    impressions: number;
    ctr: number;
    avgPosition: number;
    periodStart: Date;
    periodEnd: Date;
    topQueries: string[];
  };

  /** Competitor URLs analyzed as part of this learning */
  competitorUrls?: string[];

  /** Performance metrics at time of this learning */
  performanceMetrics?: Record<string, unknown>;

  keyword?: string; // The primary keyword for context

  createdAt: Date;
}

const BlogLearningSchema = new Schema<IBlogLearning>(
  {
    blogId: { type: Schema.Types.ObjectId, ref: "Blog", required: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    type: { type: String, required: true },
    insight: { type: String, required: true },
    evidence: { type: String, required: true },
    category: { type: String, required: true },
    confidence: { type: Number, min: 0, max: 1, default: 0.8 },
    gscSnapshot: { type: Schema.Types.Mixed },
    competitorUrls: { type: [String], default: [] },
    performanceMetrics: { type: Schema.Types.Mixed },
    keyword: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

BlogLearningSchema.index({ blogId: 1 });
BlogLearningSchema.index({ projectId: 1, createdAt: -1 });
// Supports gsc-monitor.job.ts's dedup check: "has this blog already had
// this insight type recorded within the last N days?"
BlogLearningSchema.index({ blogId: 1, type: 1, createdAt: -1 });

export const BlogLearning = mongoose.model<IBlogLearning>(
  "BlogLearning",
  BlogLearningSchema
);

// ---------------------------------------------------------------------------

/**
 * models/BlogOptimization.ts
 *
 * WHO: The result of one re-optimization run on a blog post.
 * Created when the system rewrites a blog based on BlogLearning insights.
 * Stores what changes were suggested so the user can review before applying.
 *
 * WHY SEPARATE: Written by a background job, reviewed independently by the user,
 * and can accumulate multiple optimization runs per blog over its lifetime.
 *
 * ADVANCED FEATURE: Build after BlogLearning is working.
 */

export interface IBlogOptimization extends Document {
  blogId: Types.ObjectId;
  projectId: Types.ObjectId; // denormalized — same pattern as BlogLearning above, avoids a populate() for every scoped list/access-check query

  /**
   * Proposed changes to the blog content.
   * Stored as a diff/suggestion, not applied until user approves.
   */
  contentOptimization?: {
    originalContent: string;
    optimizedContent: string;
    changesSummary: string;   // Plain-language summary of what changed and why
    learningIds: Types.ObjectId[]; // Which BlogLearnings drove this optimization
  };

  /**
   * Proposed changes to SEO meta tags.
   *
   * TIER DECISION (see docs/13-knowledge-learning-system.md): unlike
   * contentOptimization above, tag changes are auto-applied immediately —
   * lower risk (a worse title/description is cheap to notice and cheap to
   * revert) doesn't need a human in the loop the way a full content
   * rewrite does. appliedAt/rolledBackAt track that lifecycle
   * independently of the top-level `status` field, which reflects the
   * CONTENT optimization's review state only.
   */
  seoTagOptimization?: {
    originalTitle?: string;
    optimizedTitle?: string;
    originalDescription?: string;
    optimizedDescription?: string;
    originalSchema?: Record<string, unknown>;
    optimizedSchema?: Record<string, unknown>;
    /** CTR at the time this optimization was created (from the triggering BlogLearning's gscSnapshot) — the baseline the rollback check compares against. */
    baselineCtr?: number;
    /** Set the moment the tag change goes live — see blog-optimization.job.ts */
    appliedAt?: Date;
    /**
     * Set by gsc-monitor.job.ts's next cycle if GSC performance for this
     * blog got WORSE after the tag change went live — the automatic
     * safety net that makes auto-apply-without-review defensible. Uses
     * the content snapshot already sitting in Blog.history[] to revert.
     */
    rolledBackAt?: Date;
  };

  /**
   * True if this blog was published (cmsReference set) at the time the tag
   * optimization above was auto-applied, meaning the live CMS post is now
   * OUT OF SYNC with the Blog document — the DB has the new title/
   * description, but the live page still shows the old one. Set by
   * blog-optimization.job.ts. Stays true until CMS "update existing post"
   * support exists (see docs/11-cms-integrations-audit.md) and someone
   * re-publishes; there's no automatic resolution path for this yet.
   */
  cmsResyncPending?: boolean;

  status: "pending_review" | "applied" | "rejected";

  createdAt: Date;
}

const BlogOptimizationSchema = new Schema<IBlogOptimization>(
  {
    blogId: { type: Schema.Types.ObjectId, ref: "Blog", required: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    contentOptimization: { type: Schema.Types.Mixed },
    seoTagOptimization: { type: Schema.Types.Mixed },
    cmsResyncPending: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["pending_review", "applied", "rejected"],
      default: "pending_review",
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

BlogOptimizationSchema.index({ blogId: 1 });
BlogOptimizationSchema.index({ blogId: 1, status: 1 });
BlogOptimizationSchema.index({ projectId: 1, status: 1, createdAt: -1 }); // supports the review-queue list endpoint

export const BlogOptimization = mongoose.model<IBlogOptimization>(
  "BlogOptimization",
  BlogOptimizationSchema
);

// ---------------------------------------------------------------------------

/**
 * models/ProjectLearningChunk.ts
 *
 * WHO: Chunked text fragments from project content, stored with vector embeddings.
 * Used for semantic search — "find the most relevant context for this keyword"
 * before generating a blog post.
 *
 * WHY SEPARATE: Vector similarity search requires a dedicated index.
 * In MongoDB Atlas, this uses Atlas Vector Search.
 * Always queried by similarity (not by _id), never loaded with a parent doc.
 *
 * ADVANCED FEATURE: Requires MongoDB Atlas Vector Search to be enabled.
 * Build after basic blog generation works without RAG.
 *
 * SOURCES:
 *   "knowledge_file" → chunked from ProjectKnowledgeFile (uploaded docs)
 *   "blog"           → chunked from published blog content
 *   "audit"          → chunked from crawled page content
 *   "learning"       → embedded BlogLearning insight (added when wiring up
 *                      the actual learning loop — see gsc-monitor.job.ts).
 *                      Not in the original doc-comment list above; a GSC
 *                      insight isn't "chunked from" anything, it's a
 *                      structured record embedded whole, but it needs a
 *                      sourceType value of its own to be filterable
 *                      separately from brand-knowledge chunks at retrieval
 *                      time (see lib/vector-search.ts).
 *
 * EMBEDDING MODEL: Gemini text-embedding-004 (768 dimensions, free with Gemini key)
 */

export interface IProjectLearningChunk extends Document {
  projectId: Types.ObjectId;

  /** Where this chunk came from */
  sourceType: "knowledge_file" | "blog" | "audit" | "learning";

  /** The actual text content of this chunk */
  content: string;

  /**
   * The text that was actually embedded (may differ from content —
   * we sometimes prepend context like "Title: X\nContent: ...")
   */
  embeddingInputText: string;

  /**
   * The vector embedding — 768 dimensions from Gemini text-embedding-004.
   * Used for Atlas Vector Search similarity queries.
   * NOTE: Do NOT load this field in normal queries — use projection to exclude it.
   *       It's large and only needed by the vector search pipeline.
   */
  embedding?: number[];

  /** Optional reference to source document */
  blogId?: Types.ObjectId;
  fileId?: Types.ObjectId;

  /** H2/H3 heading (or table label) this chunk falls under — set by lib/chunker.ts at chunk creation time. */
  sectionTitle?: string;

  /**
   * Reference back to the BlogLearning this chunk was embedded from
   * (sourceType: "learning" only). Denormalized confidence/createdAt below
   * avoid a join at retrieval time — see quality-gate note there.
   */
  learningId?: Types.ObjectId;

  /**
   * Copied from BlogLearning.confidence at embed time (sourceType:
   * "learning" only). Denormalized deliberately — retrieval-time filtering
   * ("only apply HIGH/MEDIUM confidence learnings", per the quality
   * standards this system is built to) needs to run inside the same Atlas
   * aggregation pipeline as the vector/text search itself; joining back to
   * BlogLearning per result would mean a second query per candidate.
   * Same self-contained-at-ingestion principle this collection already
   * uses for isLikelyEvidence/containsStats/etc below.
   */
  confidence?: number;

  /**
   * Denormalized from the parent ProjectKnowledgeFile's classification
   * (sourceType: "knowledge_file" only) — same reasoning as `confidence`
   * above: filtering "LOW trust chunks excluded by default" needs to run
   * inside the retrieval aggregation, not as a follow-up lookup per file.
   */
  classifiedTrustLevel?: string; // "HIGH" | "MEDIUM" | "LOW"

  keyword?: string; // If this chunk is associated with a specific keyword

  // Metadata for re-ranking after vector search
  isLikelyEvidence?: boolean;         // Contains stats or proof points
  containsStats?: boolean;            // Has numbers/percentages
  containsObjections?: boolean;       // Has objection-handling content
  containsCustomerLanguage?: boolean; // Uses language customers use

  createdAt: Date;
}

const ProjectLearningChunkSchema = new Schema<IProjectLearningChunk>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    sourceType: {
      type: String,
      enum: ["knowledge_file", "blog", "audit", "learning"],
      required: true,
    },
    content: { type: String, required: true },
    embeddingInputText: { type: String, required: true },
    embedding: { type: [Number], select: false }, // Excluded from normal queries
    blogId: { type: Schema.Types.ObjectId, ref: "Blog" },
    fileId: { type: Schema.Types.ObjectId, ref: "ProjectKnowledgeFile" },
    sectionTitle: { type: String },
    learningId: { type: Schema.Types.ObjectId, ref: "BlogLearning" },
    confidence: { type: Number, min: 0, max: 1 },
    classifiedTrustLevel: { type: String, enum: ["HIGH", "MEDIUM", "LOW"] },
    keyword: { type: String },
    isLikelyEvidence: { type: Boolean, default: false },
    containsStats: { type: Boolean, default: false },
    containsObjections: { type: Boolean, default: false },
    containsCustomerLanguage: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ProjectLearningChunkSchema.index({ projectId: 1, sourceType: 1 });
// Vector + full-text search indexes must be created manually in Atlas UI
// (cannot be done in code — Atlas Search indexes aren't part of the
// mongoose/Node driver API). See docs/13-knowledge-learning-system.md for
// the exact JSON to paste in. Index names referenced by lib/vector-search.ts:
//   "chunk_vector_index" — $vectorSearch, field: embedding, dims: 768, cosine
//   "chunk_text_index"   — $search (BM25), fields: content, keyword

export const ProjectLearningChunk = mongoose.model<IProjectLearningChunk>(
  "ProjectLearningChunk",
  ProjectLearningChunkSchema
);
