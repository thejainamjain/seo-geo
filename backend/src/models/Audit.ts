/**
 * models/Audit.ts
 *
 * WHO: Represents one full crawl + technical audit of a project's domain.
 * Each audit scans all pages, identifies technical SEO issues (CodeChange),
 * generates FAQ and TLDR stubs, and produces an SEO score.
 *
 * WHY SEPARATE COLLECTION: Audits grow unboundedly (one per crawl run),
 * are queried independently (audit history view), and trigger cascading
 * document creation in other collections. Too large to embed in Project.
 *
 * FLOW: Trigger audit → status: "running" → crawl all pages →
 *       create CodeChange/FAQ/TLDR docs (site-crawl.job.ts) →
 *       LLM fills newHtml + FAQ + TLDR (technical-audit.job.ts) →
 *       score calculated → status: "completed"
 *
 * SCORE: Stored in summary.score (1–100). Calculated once per audit run.
 *        LLM calibrates based on weighted pass rate + site reputation.
 *        No separate field needed — summary is the right semantic home.
 */

import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IAudit extends Document {
  projectId: Types.ObjectId;
  status: 'pending' | 'running' | 'completed' | 'failed';
  errorMessage?: string;

  /** All URLs discovered and crawled during this audit */
  crawledUrls?: string[];

  /**
   * Summary counts — computed after audit completes, shown on dashboard.
   * score: LLM-calibrated SEO score 1–100 (set by technical-audit.job.ts)
   * scoreReasoning: one-sentence LLM explanation of the score
   */
  summary?: {
    totalPages:         number;
    totalFixes:         number;
    totalSchemas:       number;
    totalInternalLinks: number;
    totalFaqs:          number;
    score?:             number;  // 1–100, set after technical audit completes
    scoreReasoning?:    string;  // one sentence from LLM
  };

  performedAt:  Date;
  completedAt?: Date;
}

const AuditSchema = new Schema<IAudit>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    status: {
      type:    String,
      enum:    ['pending', 'running', 'completed', 'failed'],
      default: 'pending',
    },
    errorMessage: { type: String },
    crawledUrls:  { type: [String], default: [] },
    summary: {
      totalPages:         { type: Number, default: 0 },
      totalFixes:         { type: Number, default: 0 },
      totalSchemas:       { type: Number, default: 0 },
      totalInternalLinks: { type: Number, default: 0 },
      totalFaqs:          { type: Number, default: 0 },
      score:              { type: Number, min: 1, max: 100 },
      scoreReasoning:     { type: String },
    },
    performedAt:  { type: Date, default: Date.now },
    completedAt:  { type: Date },
  },
);

AuditSchema.index({ projectId: 1, performedAt: -1 }); // Latest audits first
AuditSchema.index({ projectId: 1, status: 1 });

export const Audit = mongoose.model<IAudit>('Audit', AuditSchema);