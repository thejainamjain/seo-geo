/**
 * models/InternalLink.ts
 *
 * WHO: An internal linking suggestion between two pages on the same domain.
 * The system finds pages that could link to each other to improve
 * crawlability and distribute link equity across the site.
 *
 * WHY SEPARATE FROM CodeChange: Internal links have a distinct
 * source → target URL relationship that CodeChange doesn't model well.
 * Keeping them separate makes it easy to:
 *   - Query "all pages that link TO this URL" (backlink graph)
 *   - Query "all links FROM this page"
 *   - Track the internal linking graph over time
 *
 * IMPLEMENTATION NOTE: SearchPilot builds this with a simple keyword-match
 * function against published blog slugs (~50 lines, no external service).
 * Start there before adding ML-based relevance scoring.
 *
 * UI: Shown in Technical SEO section under "Add internal links" category.
 */

import mongoose, { Document, Schema, Types } from "mongoose";

export interface IInternalLink extends Document {
  projectId: Types.ObjectId;

  /** The page where the link should be added */
  sourceUrl: string;

  /** The page that should be linked to */
  targetUrl: string;

  status: "pending" | "applied" | "disabled" | "failed";

  /** Anchor text + surrounding HTML before the link is added */
  oldHtml?: string;

  /** HTML with the link injected */
  newHtml?: string;

  createdAt: Date;
  appliedAt?: Date;
}

const InternalLinkSchema = new Schema<IInternalLink>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    sourceUrl: { type: String, required: true },
    targetUrl: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "applied", "disabled", "failed"],
      default: "pending",
    },
    oldHtml: { type: String },
    newHtml: { type: String },
    appliedAt: { type: Date },
  },
  { timestamps: true }
);

InternalLinkSchema.index({ projectId: 1, status: 1 });
InternalLinkSchema.index({ projectId: 1, sourceUrl: 1 });
InternalLinkSchema.index({ projectId: 1, targetUrl: 1 });

export const InternalLink = mongoose.model<IInternalLink>(
  "InternalLink",
  InternalLinkSchema
);
