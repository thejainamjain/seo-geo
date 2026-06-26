/**
 * models/GoogleToken.ts
 *
 * WHO: OAuth tokens for Google Search Console, one per project.
 *
 * WHY SEPARATE COLLECTION (not embedded in Project):
 *   GSC tokens expire and are refreshed silently by a background job every hour.
 *   If embedded in Project, every token refresh would:
 *     1. Load the entire Project document (large)
 *     2. Update Project.updatedAt (misleading — the project didn't change)
 *     3. Risk race conditions with other Project updates happening simultaneously
 *   As its own collection, the job does a targeted findOneAndUpdate on just
 *   this small document with zero impact on the Project.
 *
 * FLOW: User connects GSC → OAuth callback → save tokens here →
 *       set Project.isGscConnected = true →
 *       background job refreshes accessToken before expiryDate
 */

import mongoose, { Document, Schema, Types } from "mongoose";

export interface IGoogleToken extends Document {
  projectId: Types.ObjectId;
  accessToken: string;
  refreshToken: string;
  expiryDate: Date;
  createdAt: Date;
  updatedAt: Date;
}

const GoogleTokenSchema = new Schema<IGoogleToken>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      unique: true, // One token set per project
    },
    accessToken: { type: String, required: true },
    refreshToken: { type: String, required: true },
    expiryDate: { type: Date, required: true },
  },
  { timestamps: true }
);

GoogleTokenSchema.index({ projectId: 1 });
GoogleTokenSchema.index({ expiryDate: 1 }); // Background job queries: "tokens expiring soon"

export const GoogleToken = mongoose.model<IGoogleToken>("GoogleToken", GoogleTokenSchema);
