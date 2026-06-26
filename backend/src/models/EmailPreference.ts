/**
 * models/EmailPreference.ts
 *
 * WHO: A user's email notification opt-in/out settings.
 *
 * WHY SEPARATE COLLECTION (not embedded in User):
 *   - Unsubscribe requests must be processed fast and independently
 *     (GDPR / CAN-SPAM compliance — user clicks unsubscribe, it must work immediately)
 *   - Weekly report job queries: "all users with isSubscribedWeeklyReport: true"
 *     → much faster with a dedicated collection + index than scanning all Users
 *   - Email preference changes should not update User.updatedAt
 *   - Can be wiped independently if user requests data deletion for just emails
 *
 * CREATED: Automatically when User registers (with default opt-ins).
 */

import mongoose, { Document, Schema, Types } from "mongoose";

export interface IEmailPreference extends Document {
  userId: Types.ObjectId;

  /** Opt-in for product updates, tips, and promotional emails */
  isSubscribedMarketing: boolean;

  /** Opt-in for weekly GSC performance + SEO progress digest */
  isSubscribedWeeklyReport: boolean;

  /** Opt-in for billing alerts (payment failed, trial ending, etc.) */
  isSubscribedBillingAlerts: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const EmailPreferenceSchema = new Schema<IEmailPreference>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    isSubscribedMarketing: { type: Boolean, default: true },
    isSubscribedWeeklyReport: { type: Boolean, default: true },
    isSubscribedBillingAlerts: { type: Boolean, default: true },
  },
  { timestamps: true }
);

EmailPreferenceSchema.index({ userId: 1 });
EmailPreferenceSchema.index({ isSubscribedWeeklyReport: 1 }); // Weekly report job
EmailPreferenceSchema.index({ isSubscribedMarketing: 1 });    // Marketing campaigns

export const EmailPreference = mongoose.model<IEmailPreference>(
  "EmailPreference",
  EmailPreferenceSchema
);
