/**
 * models/Blog.ts
 *
 * WHO: An AI-generated content piece targeting one keyword.
 * This is the primary output the user sees — blogs go through a lifecycle
 * from AI draft to published on the user's CMS.
 *
 * WHY SEPARATE COLLECTION: Blogs are the most queried entity after Project.
 * Filtered by status, searched by keyword/title, and loaded individually
 * for editing. Too large to embed anywhere.
 *
 * EMBEDDED:
 *   history[] — version snapshots of content over time. Capped at 50 entries.
 *   WHY EMBEDDED: History is always accessed via its blog (never queried
 *   independently). It's bounded (we cap it). Loading blog + history
 *   together in one query is exactly what the UI needs for the version panel.
 *
 * LIFECYCLE: draft → ready → published → (re-optimized → back to draft)
 *
 * CMS PUBLISHING: When published, cmsReference stores the ID from the
 * connected CMS (WordPress post ID, Webflow item ID, etc.) so we can
 * update or unpublish it later.
 *
 * AEO/GEO: seoSchema field stores FAQ + Article schema.org structured data
 * added to this post to help AI engines cite it directly.
 *
 * NOTE ON FIELD NAME:
 *   The field is named `seoSchema` (not `schema`) to avoid colliding with
 *   Mongoose's own `Document.schema` property, which is a reserved name
 *   on every Mongoose document instance.
 */

import mongoose, { Document, Schema, Types } from "mongoose";

// ── Embedded: BlogHistory ──────────────────────────────────────────────────

/**
 * BlogHistory (embedded inside Blog, capped array)
 *
 * WHY EMBEDDED: History is always read together with the blog.
 * Never queried across blogs ("show me all v2 drafts"). Bounded (capped at 50).
 * One query loads blog + full history — perfect for the version diff panel.
 *
 * writer:
 *   "ai"     → Gemini generated or re-optimized this version
 *   "user"   → User manually edited in the editor
 *   "system" → Auto-optimization based on GSC feedback
 */
interface IBlogHistoryEntry {
  content: string;
  description?: string;
  status: "draft" | "ready" | "published" | "archived";
  writer: "ai" | "user" | "system";
  createdAt: Date;
}

const BlogHistorySchema = new Schema<IBlogHistoryEntry>(
  {
    content:     { type: String, required: true },
    description: { type: String },
    status: {
      type: String,
      enum: ["draft", "ready", "published", "archived"],
      required: true,
    },
    writer: {
      type: String,
      enum: ["ai", "user", "system"],
      default: "ai",
    },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true } // Keep _id so user can reference a specific version to restore
);

// ── Main document ──────────────────────────────────────────────────────────

export interface IBlog extends Document {
  projectId:  Types.ObjectId;
  keywordId?: Types.ObjectId; // The keyword this blog targets (optional)

  title:        string;
  slug:         string;   // URL-friendly, unique per project
  description?: string;   // Meta description / excerpt

  /** Full HTML content of the blog post */
  content?: string;

  /**
   * The content as it was actually published to the CMS.
   * May differ from `content` if the user edited after publishing.
   * We keep this so we know exactly what is live on the site.
   */
  publishedContent?: string;

  status: "draft" | "ready" | "published" | "archived";

  /**
   * schema.org structured data for AEO/GEO.
   * Typically Article + FAQPage schemas combined.
   * Stored as a plain object — serialized to a JSON-LD <script> tag when publishing.
   *
   * Named `seoSchema` (NOT `schema`) to avoid collision with Mongoose's
   * reserved `Document.schema` property.
   */
  seoSchema?: Record<string, unknown>;

  /** Reference ID from the connected CMS after publishing */
  cmsReference?: string;

  publishedDate?: Date;
  publishedUrl?:  string; // Full URL once live: "https://example.com/blog/my-post"

  /**
   * Last time this blog was re-optimized.
   * Triggered by GSC data showing the post ranks but doesn't convert.
   * Gemini rewrites sections based on real user query patterns.
   */
  lastOptimizedAt?: Date;

  /**
   * Hero image URL.
   * Fetched from Unsplash API → converted to .avif → stored in Cloudinary.
   */
  heroImageUrl?: string;

  /** Version history — capped at 50 entries (enforced in app layer via $slice) */
  history: IBlogHistoryEntry[];

  /** AI analysis of SERP/competitor content used to write this blog */
  sourceAnalysis?: Record<string, unknown>;

  /** User-provided context included in the generation prompt */
  userContext?: string;

  createdAt: Date;
  updatedAt: Date;
}

const BlogSchema = new Schema<IBlog>(
  {
    projectId:  { type: Schema.Types.ObjectId, ref: "Project",  required: true },
    keywordId:  { type: Schema.Types.ObjectId, ref: "Keyword" },

    title:            { type: String, required: true },
    slug:             { type: String, required: true },
    description:      { type: String },
    content:          { type: String },
    publishedContent: { type: String },

    status: {
      type:    String,
      enum:    ["draft", "ready", "published", "archived"],
      default: "draft",
    },

    // Named seoSchema — NOT schema (reserved by Mongoose Document)
    seoSchema:        { type: Schema.Types.Mixed },
    cmsReference:     { type: String },
    publishedDate:    { type: Date },
    publishedUrl:     { type: String },
    lastOptimizedAt:  { type: Date },
    heroImageUrl:     { type: String },

    // Capped at 50 history entries — use $push + $slice in app layer
    history:          { type: [BlogHistorySchema], default: [] },

    sourceAnalysis:   { type: Schema.Types.Mixed },
    userContext:      { type: String },
  },
  { timestamps: true }
);

// ── Indexes ────────────────────────────────────────────────────────────────
BlogSchema.index({ projectId: 1, status: 1 });
BlogSchema.index({ projectId: 1, slug: 1 }, { unique: true }); // slug unique per project
BlogSchema.index({ keywordId: 1 });
BlogSchema.index({ projectId: 1, publishedDate: -1 }); // Latest published first

export const Blog = mongoose.model<IBlog>("Blog", BlogSchema);
