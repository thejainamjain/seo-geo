/**
 * models/TLDR.ts
 *
 * WHO: A "Too Long; Didn't Read" summary block injected at the top of long pages.
 * Helps with AEO — AI search engines often pull these concise summaries
 * when answering user queries instead of crawling the full page content.
 *
 * WHY SEPARATE: Same reasoning as FAQ — distinct AEO optimization type,
 * different UI section, different AI generation pipeline.
 *
 * UI: Listed under "Optimize for AI Search" in the Technical SEO section.
 */

import mongoose, { Document, Schema, Types } from "mongoose";

export interface ITLDR extends Document {
  projectId: Types.ObjectId;
  sourceUrl: string;
  status: "pending" | "applied" | "disabled" | "failed";
  oldHtml?: string;
  newHtml?: string;

  /** The generated TLDR text shown in the UI for review before applying */
  tldrText?: string;

  createdAt: Date;
  appliedAt?: Date;
}

const TLDRSchema = new Schema<ITLDR>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    sourceUrl: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "applied", "disabled", "failed"],
      default: "pending",
    },
    oldHtml: { type: String },
    newHtml: { type: String },
    tldrText: { type: String },
    appliedAt: { type: Date },
  },
  { timestamps: true }
);

TLDRSchema.index({ projectId: 1, status: 1 });
TLDRSchema.index({ projectId: 1, sourceUrl: 1 });

export const TLDR = mongoose.model<ITLDR>("TLDR", TLDRSchema);
