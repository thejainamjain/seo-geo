/**
 * models/Audit.ts
 *
 * WHO: Represents one full crawl of a project's domain.
 * Each audit scans all pages and identifies technical SEO issues.
 * CodeChange, InternalLink, FAQ, and TLDR documents are created
 * as a result of each Audit run.
 *
 * WHY SEPARATE COLLECTION: Audits grow unboundedly (one per crawl run),
 * are queried independently (audit history view), and trigger cascading
 * document creation in other collections. Too large to embed in Project.
 *
 * FLOW: Trigger audit → status: "running" → crawl all pages →
 *       create CodeChange/FAQ/InternalLink docs → status: "completed"
 */

import mongoose, { Document, Schema, Types } from "mongoose";

export interface IAudit extends Document {
  projectId: Types.ObjectId;
  status: "pending" | "running" | "completed" | "failed";
  errorMessage?: string;

  /** All URLs discovered and crawled during this audit */
  crawledUrls?: string[];

  /** Summary counts — computed after crawl completes, shown on dashboard */
  summary?: {
    totalPages: number;
    totalFixes: number;
    totalSchemas: number;
    totalInternalLinks: number;
    totalFaqs: number;
  };

  performedAt: Date;
  completedAt?: Date;
}

const AuditSchema = new Schema<IAudit>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    status: {
      type: String,
      enum: ["pending", "running", "completed", "failed"],
      default: "pending",
    },
    errorMessage: { type: String },
    crawledUrls: { type: [String], default: [] },
    summary: {
      totalPages: { type: Number, default: 0 },
      totalFixes: { type: Number, default: 0 },
      totalSchemas: { type: Number, default: 0 },
      totalInternalLinks: { type: Number, default: 0 },
      totalFaqs: { type: Number, default: 0 },
    },
    performedAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
  }
);

AuditSchema.index({ projectId: 1, performedAt: -1 }); // Latest audits first
AuditSchema.index({ projectId: 1, status: 1 });

export const Audit = mongoose.model<IAudit>("Audit", AuditSchema);
