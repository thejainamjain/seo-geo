/**
 * models/CmsConfig.ts
 *
 * WHO: CMS connection settings and credentials for a project.
 * Stores which CMS is connected, encrypted credentials, and publish schedule.
 *
 * WHY SEPARATE COLLECTION (not embedded in Project):
 *   CMS config changes independently from everything else — user reconnects
 *   their CMS, changes blog path, toggles auto-publish, rotates API keys.
 *   As its own collection:
 *     - CMS credential rotation is a targeted update, not a Project write
 *     - Project.updatedAt stays clean
 *     - Easier to audit credential changes (updatedAt on this doc tells you when)
 *     - Can support multiple CMS connections per project in the future
 *
 * CREDENTIAL ENCRYPTION:
 *   encryptedCredentials is AES-256 encrypted BEFORE being stored.
 *   Use the lib/crypto.ts helpers: encrypt() on write, decrypt() on read.
 *   The ENCRYPTION_KEY env var is the only key — never log or expose it.
 *
 * PUBLISH SCHEDULE:
 *   RankAI publishes Mon–Sat at 5 PM PST. Sunday is blocked.
 *   allowedPublishDays enforces this — 0=Sunday, 1=Mon, ..., 6=Sat.
 *   Default is [1,2,3,4,5,6] (Mon–Sat, Sunday excluded).
 *   User cannot add 0 (Sunday) — enforced in handler layer.
 */

import mongoose, { Document, Schema, Types } from "mongoose";

export interface ICmsConfig extends Document {
  projectId: Types.ObjectId;

  /**
   * Which CMS is connected.
   * "wordpress" | "webflow" | "framer" | "wix" | "shopify" |
   * "sanity" | "squarespace" | "gohighlevel" | "custom_api" | "other"
   */
  cmsType?: string;

  /**
   * AES-256 encrypted JSON string containing API keys, tokens, passwords.
   * NEVER log this field. Decrypt in lib/crypto.ts before use.
   * Shape varies per cmsType — decrypted examples:
   *   wordpress:   { siteUrl, username, applicationPassword }
   *   webflow:     { apiToken }
   *   framer:      { projectId }
   *   shopify:     { storeName, clientId, clientSecret }
   *   sanity:      { projectId, datasetName, apiToken }
   *   squarespace: { dashboardUrl }
   *   gohighlevel: { privateIntegrationToken, blogDashboardUrl }
   *   custom_api:  { endpointUrl, authHeader }
   */
  encryptedCredentials?: string;

  /** URL path where blog posts live, e.g. "blog" → yoursite.com/blog/post-slug */
  blogPostPath: string;

  /** Whether to automatically publish ready blogs on schedule */
  autoPublish: boolean;

  /**
   * Which days of the week publishing is allowed.
   * 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday
   *
   * DEFAULT: [1,2,3,4,5,6] — Mon through Sat. Sunday (0) is NEVER included.
   * RULE: Sunday publishing is blocked. Handler must reject any attempt to add 0.
   * This matches RankAI's schedule: Mon–Sat at 5 PM PST.
   */
  allowedPublishDays: number[];

  /**
   * Hour of day to publish (24h UTC).
   * Default: 17 (5 PM PST = midnight UTC... adjust to your timezone strategy)
   * For v1 we use UTC for all projects. Per-project timezone comes later.
   */
  publishHourUtc: number;

  /** Strip h1 and hero image from article API body (for custom_api integrations) */
  stripTitleAndHeroFromApiBody: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const CmsConfigSchema = new Schema<ICmsConfig>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      unique: true,
    },
    cmsType: { type: String },
    encryptedCredentials: { type: String, select: false }, // Never returned by default queries
    blogPostPath: { type: String, default: "blog" },
    autoPublish: { type: Boolean, default: false },

    allowedPublishDays: {
      type: [Number],
      default: [1, 2, 3, 4, 5, 6], // Mon–Sat. Sunday (0) excluded always.
      validate: {
        validator: (days: number[]) => !days.includes(0), // Reject if Sunday is added
        message: "Sunday (0) publishing is not allowed.",
      },
    },

    publishHourUtc: {
      type: Number,
      default: 17,
      min: 0,
      max: 23,
    },

    stripTitleAndHeroFromApiBody: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const CmsConfig = mongoose.model<ICmsConfig>("CmsConfig", CmsConfigSchema);
