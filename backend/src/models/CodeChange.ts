/**
 * models/CodeChange.ts
 *
 * WHO: A single technical SEO fix identified on a specific page URL.
 * Examples: add missing alt text, add canonical tag, fix broken link,
 * add schema markup, optimize title tag, add Open Graph tags.
 *
 * WHY SEPARATE COLLECTION: Thousands can exist per project (SearchPilot showed
 * 2,167 for a single site). Heavily queried and filtered by:
 *   - status (pending / applied / disabled / failed)
 *   - type (title / alt_text / schema / canonical / etc.)
 *   - url (all fixes for a specific page)
 * Embedding in Audit or Project would make these queries painful.
 *
 * UI: Shows in "Technical SEO & GEO" section as a before/after diff.
 * User can click "Apply Changes" to push the fix to their site via CMS.
 *
 * FLOW: Audit runs → CodeChange docs created with status "pending" →
 *       user reviews → clicks Apply → status becomes "applied" or "failed"
 */

import mongoose, { Document, Schema, Types } from "mongoose";

export interface ICodeChange extends Document {
  projectId: Types.ObjectId;
  auditId: Types.ObjectId;

  /** The page URL this fix applies to */
  url: string;

  /**
   * Category of fix — used for filtering in the UI sidebar.
   * Values match what SearchPilot shows:
   * "title" | "description" | "alt_text" | "canonical" | "schema" |
   * "open_graph" | "internal_link" | "link_title" | "broken_link"
   */
  type: string;

  status: "pending" | "applied" | "disabled" | "failed";

  /** XPath or CSS selector targeting the DOM element to modify */
  xPath?: string;

  /** The HTML before the fix — shown in diff UI */
  oldHtml?: string;

  /** The HTML after the fix — what gets pushed to the CMS */
  newHtml?: string;

  /** Extra attributes to set on the element, e.g. { alt: "Product image" } */
  htmlAttributes?: Record<string, string>;

  createdAt: Date;
  appliedAt?: Date;
}

const CodeChangeSchema = new Schema<ICodeChange>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    auditId: { type: Schema.Types.ObjectId, ref: "Audit", required: true },
    url: { type: String, required: true },
    type: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "applied", "disabled", "failed"],
      default: "pending",
    },
    xPath: { type: String },
    oldHtml: { type: String },
    newHtml: { type: String },
    htmlAttributes: { type: Schema.Types.Mixed },
    appliedAt: { type: Date },
  },
  { timestamps: true }
);

// Indexes — match the most common query patterns in the UI
CodeChangeSchema.index({ projectId: 1, status: 1 });           // Filter by status
CodeChangeSchema.index({ projectId: 1, type: 1 });             // Filter by type
CodeChangeSchema.index({ projectId: 1, url: 1 });              // All fixes for a page
CodeChangeSchema.index({ auditId: 1 });                        // All fixes from an audit

export const CodeChange = mongoose.model<ICodeChange>("CodeChange", CodeChangeSchema);