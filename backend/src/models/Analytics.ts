/**
 * models/GeoAnalyticsRun.ts
 *
 * WHO: Tracks GEO (Generative Engine Optimization) performance over time.
 * Measures how often the project's domain is cited/mentioned by AI search
 * engines (ChatGPT, Perplexity, Gemini) when users ask relevant queries.
 *
 * WHY SEPARATE COLLECTION: Time-series data — one run per period (weekly/monthly).
 * Grows unboundedly. Queried independently to chart GEO score trends.
 * Background job writes this; UI reads it.
 *
 * HOW IT WORKS:
 *   1. Take the project's target keywords
 *   2. For each keyword, prompt Gemini/GPT/Perplexity with a realistic user query
 *   3. Check if the project's domain appears in the AI's response
 *   4. Calculate percentage: (appearances / total prompts) * 100
 *   5. Store result here for trend charts
 *
 * UI: Shown on the Analytics dashboard as "GEO Score" with a trend line.
 */

import mongoose, { Document, Schema, Types } from "mongoose";

export interface IGeoAnalyticsRun extends Document {
  projectId: Types.ObjectId;
  status: "pending" | "running" | "completed" | "failed";

  /** Which period this run covers (0 = first run, 1 = second, etc.) */
  periodIndex: number;

  /** How many AI prompts were sent in this run */
  evaluationPoolSize: number;
  successfulPrompts: number;
  failedPrompts: number;
  totalAttempts: number;

  /**
   * % of AI responses that cited this domain (0–100).
   * This is the main GEO score shown in the UI.
   */
  objectivePercentage: number;

  /** Previous run's score — used to show up/down trend in UI */
  prevObjectivePercentage: number;

  runAt: Date;
  completedAt?: Date;
}

const GeoAnalyticsRunSchema = new Schema<IGeoAnalyticsRun>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    status: {
      type: String,
      enum: ["pending", "running", "completed", "failed"],
      default: "pending",
    },
    periodIndex: { type: Number, required: true, default: 0 },
    evaluationPoolSize: { type: Number, default: 0 },
    successfulPrompts: { type: Number, default: 0 },
    failedPrompts: { type: Number, default: 0 },
    totalAttempts: { type: Number, default: 0 },
    objectivePercentage: { type: Number, default: 0 },
    prevObjectivePercentage: { type: Number, default: 0 },
    runAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
  }
);

GeoAnalyticsRunSchema.index({ projectId: 1, runAt: -1 }); // Latest runs first
GeoAnalyticsRunSchema.index({ projectId: 1, periodIndex: 1 });

export const GeoAnalyticsRun = mongoose.model<IGeoAnalyticsRun>(
  "GeoAnalyticsRun",
  GeoAnalyticsRunSchema
);

// ---------------------------------------------------------------------------

/**
 * models/SalesCallResearchRun.ts
 *
 * WHO: Pre-call research report for agency sales teams.
 * Before an agency calls a potential client, they enter the client's URL
 * and the system crawls + analyzes it to generate a research report:
 * current SEO state, quick wins, estimated improvement potential.
 *
 * WHY SEPARATE: Completely separate feature from the main optimization app.
 * Used by the agency's sales team, not by end users. Background job writes
 * the report asynchronously after the URL is submitted.
 *
 * ADVANCED FEATURE: Build after core product is stable.
 */

export interface ISalesCallResearchRun extends Document {
  clientUrl: string;
  clientDomain: string;
  status: "pending" | "running" | "completed" | "failed";
  errorMessage?: string;

  /**
   * The full research report as a structured JSON object.
   * Contents: SEO score, top issues, keyword opportunities,
   * competitor analysis, estimated traffic potential.
   */
  resultPayload?: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
}

const SalesCallResearchRunSchema = new Schema<ISalesCallResearchRun>(
  {
    clientUrl: { type: String, required: true },
    clientDomain: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "running", "completed", "failed"],
      default: "pending",
    },
    errorMessage: { type: String },
    resultPayload: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

SalesCallResearchRunSchema.index({ clientDomain: 1 });
SalesCallResearchRunSchema.index({ status: 1 });

export const SalesCallResearchRun = mongoose.model<ISalesCallResearchRun>(
  "SalesCallResearchRun",
  SalesCallResearchRunSchema
);

// ---------------------------------------------------------------------------

/**
 * models/EnterpriseAuditRun.ts
 *
 * WHO: A comprehensive SEO/GEO audit for enterprise prospects.
 * More detailed than the free public audit (AuditLead). Generated for
 * agencies proposing to enterprise clients. Includes AI readiness score,
 * projection multipliers, and full competitive analysis.
 *
 * WHY SEPARATE: Enterprise tier feature, completely different pipeline
 * from regular project audits. Can take 10–30 minutes to complete.
 *
 * ADVANCED FEATURE: Enterprise tier only. Build much later.
 */

export interface IEnterpriseAuditRun extends Document {
  domain: string;
  status: "pending" | "running" | "completed" | "failed";
  errorMessage?: string;

  /** Full audit result — large nested object with scores, issues, recommendations */
  resultData?: Record<string, unknown>;

  /** Multiplier applied to traffic projections for this client's industry */
  projectionMultiplier?: number;

  /** Manual override for AI readiness score (set by sales team) */
  aiReadinessOverride?: number;

  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

const EnterpriseAuditRunSchema = new Schema<IEnterpriseAuditRun>(
  {
    domain: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "running", "completed", "failed"],
      default: "pending",
    },
    errorMessage: { type: String },
    resultData: { type: Schema.Types.Mixed },
    projectionMultiplier: { type: Number },
    aiReadinessOverride: { type: Number },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

EnterpriseAuditRunSchema.index({ domain: 1 });
EnterpriseAuditRunSchema.index({ status: 1 });

export const EnterpriseAuditRun = mongoose.model<IEnterpriseAuditRun>(
  "EnterpriseAuditRun",
  EnterpriseAuditRunSchema
);

// ---------------------------------------------------------------------------

/**
 * models/AuditLead.ts
 *
 * WHO: A lead captured via the public "Free SEO/GEO Audit" page.
 * Visitors enter their name, email, and domain → get a free audit report →
 * we capture their details for follow-up / conversion to paid.
 *
 * WHY SEPARATE: Marketing funnel data, completely separate from the
 * authenticated app. Never references a User or Project — the visitor
 * may not even have an account yet.
 *
 * UI: rankai.ai/audit?domain=example.com — public landing page.
 */

export interface IAuditLead extends Document {
  websiteUrl: string;
  email: string;
  name?: string;

  /** Business size qualification from the audit form */
  signupQualification?: "over_150k" | "under_150k" | "agency";

  // UTM attribution
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  gclid?: string;

  /** Any extra data collected on the form */
  metadata?: Record<string, unknown>;

  createdAt: Date;
}

const AuditLeadSchema = new Schema<IAuditLead>(
  {
    websiteUrl: { type: String, required: true },
    email: { type: String, required: true, lowercase: true },
    name: { type: String },
    signupQualification: {
      type: String,
      enum: ["over_150k", "under_150k", "agency"],
    },
    utmSource: { type: String },
    utmMedium: { type: String },
    utmCampaign: { type: String },
    gclid: { type: String },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AuditLeadSchema.index({ email: 1 });
AuditLeadSchema.index({ createdAt: -1 });

export const AuditLead = mongoose.model<IAuditLead>("AuditLead", AuditLeadSchema);

// ---------------------------------------------------------------------------

/**
 * models/EmailLog.ts
 *
 * WHO: A record of every transactional email sent by the platform.
 * Examples: invite emails, welcome emails, weekly GSC reports, billing alerts.
 *
 * WHY SEPARATE: Append-only operational log. Queried for debugging
 * ("did the user receive their invite?") and rate-limiting. Never
 * loaded together with any other model.
 *
 * PROVIDER: Resend / Mailgun — store their message ID in providerId
 * for cross-referencing in the provider dashboard.
 */

export interface IEmailLog extends Document {
  recipientEmail: string;

  /**
   * Template name — matches the template file/function used.
   * e.g. "org_invite" | "welcome" | "weekly_report" | "billing_alert"
   */
  template: string;

  status: "sent" | "delivered" | "failed" | "bounced";
  errorMessage?: string;

  /** Message ID from email provider for cross-referencing */
  providerId?: string;

  createdAt: Date;
}

const EmailLogSchema = new Schema<IEmailLog>(
  {
    recipientEmail: { type: String, required: true, lowercase: true },
    template: { type: String, required: true },
    status: {
      type: String,
      enum: ["sent", "delivered", "failed", "bounced"],
      default: "sent",
    },
    errorMessage: { type: String },
    providerId: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

EmailLogSchema.index({ recipientEmail: 1 });
EmailLogSchema.index({ template: 1, createdAt: -1 });

export const EmailLog = mongoose.model<IEmailLog>("EmailLog", EmailLogSchema);

// ---------------------------------------------------------------------------

/**
 * models/AppError.ts
 *
 * WHO: Internal error log for background job failures.
 * When a BullMQ job fails (crawl error, LLM timeout, CMS publish failure),
 * we write here for debugging and alerting.
 *
 * WHY SEPARATE: Operational table for the engineering team.
 * Never shown to end users. Used to trigger alerts when error rates spike.
 * Named AppError (not Error) to avoid collision with JS's built-in Error class.
 */

export interface IAppError extends Document {
  /**
   * Which background job or pipeline step failed.
   * e.g. "audit_crawl" | "blog_generation" | "cms_publish" | "geo_analytics"
   */
  taskType: string;

  /** Serialized error details — stack trace, input params, etc. */
  extraInfo?: Record<string, unknown>;

  /** Whether an alert has been sent for this error (prevents duplicate alerts) */
  alertSent: boolean;

  createdAt: Date;
}

const AppErrorSchema = new Schema<IAppError>(
  {
    taskType: { type: String, required: true },
    extraInfo: { type: Schema.Types.Mixed },
    alertSent: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AppErrorSchema.index({ taskType: 1, createdAt: -1 });
AppErrorSchema.index({ alertSent: 1 }); // Fast query for unsent alerts

export const AppError = mongoose.model<IAppError>("AppError", AppErrorSchema);
