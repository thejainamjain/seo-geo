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
 *        Deterministic — computed mechanically from real per-factor check
 *        totals (weighted pass rate). LLM only supplies a one-sentence
 *        explanation (summary.scoreReasoning), it does not set the number.
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
   * score: deterministic weighted-pass-rate score 1–100, computed
   *        mechanically from real per-factor check totals (see
   *        checkTotals below) by technical-audit.job.ts. Reproducible —
   *        the same technical state always produces the same score.
   * scoreReasoning: one-sentence LLM explanation of the score (LLM only
   *        explains it, does not set the number).
   */
  summary?: {
    totalPages:         number;
    totalFixes:         number;
    totalSchemas:       number;
    totalInternalLinks: number;
    totalFaqs:          number;
    /**
     * Real per-CodeChange-type check totals computed at crawl time from
     * actual page content (e.g. alt_text → total images found, link_title →
     * total external links found), keyed by CodeChange.type. Set by
     * site-crawl.job.ts; read by technical-audit.job.ts's
     * calculateWeightedScore() as the exact denominator per factor, instead
     * of approximating with an even split across factor types.
     */
    checkTotals?:       Record<string, number>;
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
      checkTotals:        { type: Schema.Types.Mixed, default: {} },
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
