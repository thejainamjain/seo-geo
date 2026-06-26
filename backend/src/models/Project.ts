/**
 * models/Project.ts
 *
 * THE CENTRAL MODEL. Represents one website domain being optimized.
 * Every piece of analysis, content, keyword, and fix references a Project.
 *
 * One organization can have many projects.
 * In agency context: each client website = one Project.
 * In individual context: user's own website(s) = their Projects.
 *
 * NOTHING IS EMBEDDED HERE — all related data lives in its own collection:
 *   GoogleToken      → models/GoogleToken.ts       (separate — refreshed by background job)
 *   BusinessContext  → models/BusinessContext.ts   (separate — written step by step in onboarding)
 *   OnboardingState  → models/OnboardingState.ts   (separate — updated independently per step)
 *   CmsConfig        → models/CmsConfig.ts         (separate — updated when CMS changes)
 *
 * WHY NOT EMBEDDED: Even though these are 1:1 with Project, keeping them separate means:
 *   - Background jobs can update GoogleToken without loading the full Project doc
 *   - Onboarding wizard updates one step at a time without touching Project
 *   - CMS credentials update independently without triggering Project.updatedAt
 *   - Each concern has a clear, single-responsibility model
 */

import mongoose, { Document, Schema, Types } from 'mongoose';
import { PIPELINE_SEQUENCE, type PipelineStep } from '../constants/seo-pipeline.constants';

// ── Pipeline step state ────────────────────────────────────────────────────

interface IPipelineStepState {
  status:       'PENDING' | 'RUNNING' | 'COMPLETED' | 'ERRORED';
  startedAt?:   Date;
  completedAt?: Date;
  error?:       string;
}

type IPipelineSteps = Partial<Record<PipelineStep, IPipelineStepState>>;

interface IPipeline {
  jobId?:       string; // BullMQ job ID
  currentStep?: PipelineStep;
  status:       'PENDING' | 'RUNNING' | 'COMPLETED' | 'ERRORED';
  startedAt?:   Date;
  completedAt?: Date;
  steps:        IPipelineSteps;
}

// ── Main document ──────────────────────────────────────────────────────────

export interface IProject extends Document {
  domain:         string;
  organizationId: Types.ObjectId;
  ownerId:        Types.ObjectId;

  // Subscription
  isSubscribed:          boolean;
  stripeCustomerId?:     string;
  stripeSubscriptionId?: string;
  trialEndsAt?:          Date;
  subscriptionEndDate?:  Date;
  cancelAtPeriodEnd:     boolean;

  // Feature flags
  isGscConnected:          boolean;
  isCmsConnected:          boolean;
  isOwnershipVerified:     boolean;
  isKeywordsPicked:        boolean;
  isTechnicalSeoConnected: boolean;
  isOnboardingComplete:    boolean;

  // GSC
  gscPropertyType?:       'site' | 'domain';
  gscTargetCountryCodes?: string[];

  // AI config
  autoBlogConfig?:       Record<string, unknown>;
  keywordPillars?:       Record<string, unknown>;
  blogWriterInstruction?: string;

  // Pipeline state
  pipeline: IPipeline;

  createdAt: Date;
  updatedAt: Date;
}

// ── Pipeline step schema ───────────────────────────────────────────────────

const PipelineStepStateSchema = new Schema<IPipelineStepState>(
  {
    status:      { type: String, enum: ['PENDING', 'RUNNING', 'COMPLETED', 'ERRORED'], default: 'PENDING' },
    startedAt:   { type: Date },
    completedAt: { type: Date },
    error:       { type: String },
  },
  { _id: false },
);

// Build default steps object — all PENDING at creation
function defaultSteps(): IPipelineSteps {
  const steps: IPipelineSteps = {};
  for (const step of PIPELINE_SEQUENCE) {
    steps[step] = { status: 'PENDING' };
  }
  return steps;
}

const PipelineSchema = new Schema<IPipeline>(
  {
    jobId:       { type: String },
    currentStep: { type: String },
    status:      { type: String, enum: ['PENDING', 'RUNNING', 'COMPLETED', 'ERRORED'], default: 'PENDING' },
    startedAt:   { type: Date },
    completedAt: { type: Date },
    steps:       { type: Schema.Types.Mixed, default: defaultSteps },
  },
  { _id: false },
);

// ── Project schema ─────────────────────────────────────────────────────────

const ProjectSchema = new Schema<IProject>(
  {
    domain:         { type: String, required: true, trim: true, lowercase: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    ownerId:        { type: Schema.Types.ObjectId, ref: 'User', required: true },

    isSubscribed:          { type: Boolean, default: false },
    stripeCustomerId:      { type: String },
    stripeSubscriptionId:  { type: String },
    trialEndsAt:           { type: Date },
    subscriptionEndDate:   { type: Date },
    cancelAtPeriodEnd:     { type: Boolean, default: false },

    isGscConnected:          { type: Boolean, default: false },
    isCmsConnected:          { type: Boolean, default: false },
    isOwnershipVerified:     { type: Boolean, default: false },
    isKeywordsPicked:        { type: Boolean, default: false },
    isTechnicalSeoConnected: { type: Boolean, default: false },
    isOnboardingComplete:    { type: Boolean, default: false },

    gscPropertyType:       { type: String, enum: ['site', 'domain'] },
    gscTargetCountryCodes: { type: [String], default: [] },

    autoBlogConfig:        { type: Schema.Types.Mixed },
    keywordPillars:        { type: Schema.Types.Mixed },
    blogWriterInstruction: { type: String },

    pipeline: { type: PipelineSchema, default: () => ({ status: 'PENDING', steps: defaultSteps() }) },
  },
  { timestamps: true },
);

ProjectSchema.index({ organizationId: 1 });
ProjectSchema.index({ domain: 1, organizationId: 1 }, { unique: true });
ProjectSchema.index({ ownerId: 1 });

export const Project = mongoose.model<IProject>('Project', ProjectSchema);
