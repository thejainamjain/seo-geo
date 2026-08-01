/**
 * models/ProjectImage.ts
 *
 * WHAT: The pool of hero images a user uploads once in project Settings
 * ("Image configuration"). This is the PRIMARY source for blog hero
 * images — Unsplash (lib/unsplash.ts) is only the fallback used once this
 * pool has no unclaimed image left. No limit on how many images a project
 * can upload here (enforced nowhere by design — the screenshot this UI is
 * based on explicitly says "no limit here").
 *
 * LIFECYCLE: 'available' → claimed by exactly one blog → 'used'. Claiming
 * is atomic (see lib/hero-image-pool.ts's claimPoolImage, a single
 * findOneAndUpdate) so two blogs generating/publishing concurrently can't
 * both grab the same image. Once 'used', an image stays in this
 * collection (tagged with which blog took it, matching the reference UI's
 * "images already used in past blogs are tagged below") rather than being
 * deleted — deleting it here doesn't affect the blog that already claimed
 * it, since the claimed URL is copied onto Blog.heroImageUrl directly, not
 * referenced back to this collection.
 *
 * WHY SEPARATE COLLECTION (not embedded in Project): same reasoning as
 * ProjectKnowledgeFile — an unbounded, independently-mutated list (upload/
 * claim/delete) is awkward to manage as a Project sub-array, especially
 * with the atomic per-image claim needed here.
 */

import mongoose, { Document, Schema, Types } from "mongoose";

export interface IProjectImage extends Document {
  projectId:    Types.ObjectId;
  url:          string;  // Cloudinary secure_url
  publicId:     string;  // Cloudinary public_id, needed to delete the asset
  status:       "available" | "used";
  usedByBlogId?: Types.ObjectId;
  usedAt?:      Date;
  createdAt:    Date;
  updatedAt:    Date;
}

const ProjectImageSchema = new Schema<IProjectImage>(
  {
    projectId:    { type: Schema.Types.ObjectId, ref: "Project", required: true },
    url:          { type: String, required: true },
    publicId:     { type: String, required: true },
    status:       { type: String, enum: ["available", "used"], default: "available" },
    usedByBlogId: { type: Schema.Types.ObjectId, ref: "Blog" },
    usedAt:       { type: Date },
  },
  { timestamps: true },
);

// Used by claimPoolImage's findOneAndUpdate (projectId + status: 'available',
// oldest first) and by the settings list view (projectId, newest first).
ProjectImageSchema.index({ projectId: 1, status: 1, createdAt: 1 });

export const ProjectImage = mongoose.model<IProjectImage>("ProjectImage", ProjectImageSchema);
