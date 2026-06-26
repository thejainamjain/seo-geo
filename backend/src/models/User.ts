/**
 * models/User.ts
 *
 * WHO: Anyone who can log in to the platform.
 * A User always belongs to at least one Organization via OrganizationMember.
 *
 * NOTHING EMBEDDED — EmailPreference is its own collection:
 *   EmailPreference → models/EmailPreference.ts
 *
 * WHY NOT EMBEDDED:
 *   - Unsubscribe requests must be processed quickly and independently
 *     (legal requirement in many regions — GDPR, CAN-SPAM)
 *   - Email preference updates should not touch User.updatedAt
 *   - Background job queries "all users subscribed to weekly reports"
 *     which is easier with a dedicated collection + index
 *
 * AUTH: Passwords are bcrypt-hashed. JWT tokens reference user._id.
 */

import mongoose, { Document, Schema } from "mongoose";

export interface IUser extends Document {
  email: string;
  passwordHash: string;
  name: string;
  avatarUrl?: string;

  /**
   * Which account type this user signed up as.
   * Used for onboarding flow and analytics ONLY — not for permissions.
   * Permissions come from OrganizationMember.role.
   */
  accountType: "individual" | "agency";

  // UTM attribution — how did this user find us?
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  gclid?: string;

  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    avatarUrl: { type: String },
    accountType: {
      type: String,
      enum: ["individual", "agency"],
      default: "individual",
    },
    utmSource: { type: String },
    utmMedium: { type: String },
    utmCampaign: { type: String },
    gclid: { type: String },
  },
  { timestamps: true }
);

UserSchema.index({ email: 1 });

export const User = mongoose.model<IUser>("User", UserSchema);
