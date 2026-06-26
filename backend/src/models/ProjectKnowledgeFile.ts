/**
 * models/ProjectKnowledgeFile.ts
 *
 * WHO: Documents uploaded by the user to give the AI context about their business.
 * Examples: brand guidelines, product sheets, pricing docs, FAQs, case studies.
 * Up to 25 files per project (enforced in application layer).
 *
 * WHY SEPARATE COLLECTION: Files are processed asynchronously by background jobs.
 * Status is updated independently (PENDING → PROCESSING → READY | ERROR).
 * Would be chaotic to embed in Project and update via $set on a nested array item.
 *
 * FLOW: Upload → store in Cloudinary → create doc here with PENDING →
 *       background job classifies it with Gemini → update to READY
 */

import mongoose, { Document, Schema, Types } from "mongoose";

export interface IProjectKnowledgeFile extends Document {
  projectId: Types.ObjectId;
  originalName: string;
  mimeType: string;   // "application/pdf", "text/plain", "text/markdown", etc.
  sizeBytes: number;
  storageUrl: string; // Cloudinary URL

  /** Processing status — updated by background job */
  status: "pending" | "processing" | "ready" | "error";
  errorMessage?: string;

  // AI classification results — what kind of doc is this and how should AI use it?
  classifiedDocumentKind?: string;   // e.g. "brand_guide", "product_sheet", "case_study"
  classifiedUsageTags?: string[];    // e.g. ["tone_reference", "fact_source"]
  classifiedAudience?: string;
  classifiedTrustLevel?: string;
  classificationReasoning?: string;
  classifiedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const ProjectKnowledgeFileSchema = new Schema<IProjectKnowledgeFile>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    storageUrl: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "processing", "ready", "error"],
      default: "pending",
    },
    errorMessage: { type: String },
    classifiedDocumentKind: { type: String },
    classifiedUsageTags: { type: [String], default: [] },
    classifiedAudience: { type: String },
    classifiedTrustLevel: { type: String },
    classificationReasoning: { type: String },
    classifiedAt: { type: Date },
  },
  { timestamps: true }
);

ProjectKnowledgeFileSchema.index({ projectId: 1 });
ProjectKnowledgeFileSchema.index({ projectId: 1, status: 1 });

export const ProjectKnowledgeFile = mongoose.model<IProjectKnowledgeFile>(
  "ProjectKnowledgeFile",
  ProjectKnowledgeFileSchema
);
