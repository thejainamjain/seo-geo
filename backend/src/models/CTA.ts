/**
 * models/CTA.ts
 *
 * WHO: A Call-To-Action injection suggested for a specific page.
 * The system identifies pages that could convert better with a CTA
 * (e.g. a "Book a call" button, a newsletter signup, a product link)
 * and suggests where to inject it.
 *
 * WHY SEPARATE: CTA optimization is a conversion-focused feature distinct
 * from technical SEO (CodeChange) and AEO (FAQ/TLDR). Agencies use this
 * to improve client site conversions alongside SEO improvements.
 *
 * RELATED: ProjectCtaForm — the actual form HTML template used across
 * CTA injections for this project.
 */

import mongoose, { Document, Schema, Types } from "mongoose";

export interface ICTA extends Document {
  projectId: Types.ObjectId;

  /** Page where the CTA should appear */
  sourceUrl: string;

  /** URL the CTA links to (e.g. /contact, /book-call) */
  targetUrl: string;

  status: "pending" | "applied" | "disabled" | "failed";
  oldHtml?: string;
  newHtml?: string;

  createdAt: Date;
  appliedAt?: Date;
}

const CTASchema = new Schema<ICTA>(
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

CTASchema.index({ projectId: 1, status: 1 });
CTASchema.index({ projectId: 1, sourceUrl: 1 });

export const CTA = mongoose.model<ICTA>("CTA", CTASchema);

// ---------------------------------------------------------------------------

/**
 * models/ProjectCtaForm.ts
 *
 * WHO: The reusable form/widget HTML template for a project's CTA injections.
 * One per project. When a CTA is created, it references this template.
 *
 * WHY SEPARATE FROM CTA: The form template is defined once per project
 * and reused across all CTA injections. Embedding it in every CTA doc
 * would duplicate a potentially large HTML string thousands of times.
 *
 * ALSO TRACKS: Form submissions (name + email) so agencies can see
 * leads generated through RankAI-injected CTAs.
 */

export interface IProjectCtaForm extends Document {
  projectId: Types.ObjectId;

  /** The HTML/React content of the form widget */
  formContent: string;

  /** Submissions collected via this form */
  submissions: Array<{
    name?: string;
    email: string;
    blogId?: Types.ObjectId;
    submittedAt: Date;
  }>;

  createdAt: Date;
}

const ProjectCtaFormSchema = new Schema<IProjectCtaForm>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      unique: true, // One form template per project
    },
    formContent: { type: String, required: true },
    submissions: [
      {
        name: { type: String },
        email: { type: String, required: true },
        blogId: { type: Schema.Types.ObjectId, ref: "Blog" },
        submittedAt: { type: Date, default: Date.now },
        _id: false,
      },
    ],
  },
  { timestamps: true }
);

export const ProjectCtaForm = mongoose.model<IProjectCtaForm>(
  "ProjectCtaForm",
  ProjectCtaFormSchema
);
