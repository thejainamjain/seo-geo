/**
 * models/FAQ.ts
 *
 * WHO: A structured FAQ block suggested for injection into a specific page.
 * These are Q&A pairs that help with AEO (Answer Engine Optimization)
 * by making content directly answerable by AI search engines like
 * ChatGPT, Perplexity, and Gemini.
 *
 * WHY SEPARATE FROM CodeChange: FAQs target a different optimization goal.
 * CodeChange = technical SEO (fixing what's broken).
 * FAQ = AEO (adding structured content AI engines can cite directly).
 * Keeping them separate lets us show AEO-specific progress metrics in the UI
 * and lets the AI generate FAQs in a different pipeline from technical fixes.
 *
 * SCHEMA MARKUP: When a FAQ is applied, we also add FAQ schema.org markup
 * to the page so Google can show it as a rich result.
 *
 * UI: Shown in the "Technical SEO & GEO" section.
 */

import mongoose, { Document, Schema, Types } from "mongoose";

export interface IFAQ extends Document {
  projectId: Types.ObjectId;
  auditId:   Types.ObjectId;

  /** The page URL where this FAQ block should be injected */
  sourceUrl: string;

  status: "pending" | "applied" | "disabled" | "failed";

  /** Page HTML before FAQ injection */
  oldHtml?: string;

  /** Page HTML after FAQ block is injected (includes schema markup) */
  newHtml?: string;

  /**
   * The actual Q&A pairs as structured data.
   * Stored here so we can display them in the UI before applying.
   */
  questions?: Array<{
    question: string;
    answer: string;
  }>;

  createdAt: Date;
  appliedAt?: Date;
}

const FAQSchema = new Schema<IFAQ>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    auditId:   { type: Schema.Types.ObjectId, ref: "Audit", required: true },
    sourceUrl: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "applied", "disabled", "failed"],
      default: "pending",
    },
    oldHtml: { type: String },
    newHtml: { type: String },
    questions: [
      {
        question: { type: String },
        answer: { type: String },
        _id: false,
      },
    ],
    appliedAt: { type: Date },
  },
  { timestamps: true }
);

FAQSchema.index({ projectId: 1, status: 1 });
FAQSchema.index({ projectId: 1, sourceUrl: 1 });
FAQSchema.index({ auditId: 1 });

export const FAQ = mongoose.model<IFAQ>("FAQ", FAQSchema);
