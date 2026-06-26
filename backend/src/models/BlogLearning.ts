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
   */
  seoTagOptimization?: {
    originalTitle?: string;
    optimizedTitle?: string;
    originalDescription?: string;
    optimizedDescription?: string;
  };

  status: "pending_review" | "applied" | "rejected";

  createdAt: Date;
}

const BlogOptimizationSchema = new Schema<IBlogOptimization>(
  {
    blogId: { type: Schema.Types.ObjectId, ref: "Blog", required: true },
    contentOptimization: { type: Schema.Types.Mixed },
    seoTagOptimization: { type: Schema.Types.Mixed },
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
 *
 * EMBEDDING MODEL: Gemini text-embedding-004 (768 dimensions, free with Gemini key)
 */

export interface IProjectLearningChunk extends Document {
  projectId: Types.ObjectId;

  /** Where this chunk came from */
  sourceType: "knowledge_file" | "blog" | "audit";

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
      enum: ["knowledge_file", "blog", "audit"],
      required: true,
    },
    content: { type: String, required: true },
    embeddingInputText: { type: String, required: true },
    embedding: { type: [Number], select: false }, // Excluded from normal queries
    blogId: { type: Schema.Types.ObjectId, ref: "Blog" },
    fileId: { type: Schema.Types.ObjectId, ref: "ProjectKnowledgeFile" },
    keyword: { type: String },
    isLikelyEvidence: { type: Boolean, default: false },
    containsStats: { type: Boolean, default: false },
    containsObjections: { type: Boolean, default: false },
    containsCustomerLanguage: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ProjectLearningChunkSchema.index({ projectId: 1, sourceType: 1 });
// Vector search index must be created separately in Atlas UI or via Atlas CLI
// Index name: "vector_index", field: "embedding", dimensions: 768, similarity: "cosine"

export const ProjectLearningChunk = mongoose.model<IProjectLearningChunk>(
  "ProjectLearningChunk",
  ProjectLearningChunkSchema
);
