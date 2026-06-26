/**
 * models/BusinessContext.ts
 *
 * WHO: The 5-step onboarding wizard data collected per project.
 * Steps: Company → Product → Customers → Competition → Social Proof
 *
 * WHY SEPARATE COLLECTION (not embedded in Project):
 *   The onboarding wizard saves each step independently — user fills step 1,
 *   clicks Continue, we save. Then step 2, save. Etc.
 *   If embedded in Project, each step save would update the whole Project doc.
 *   As its own collection:
 *     - Each step is a clean targeted update to just this document
 *     - Project.updatedAt stays meaningful (reflects actual project config changes)
 *     - Easy to query "how many users completed step 3?" for funnel analytics
 *     - Can be cleared and re-done without touching Project
 *
 * HOW IT'S USED: Fed to Gemini as context on every blog generation,
 * FAQ creation, and keyword research call so the AI understands the business.
 */

import mongoose, { Document, Schema, Types } from "mongoose";

export interface IBusinessContext extends Document {
  projectId: Types.ObjectId;

  // Step 1: Company details
  company?: {
    name?: string;
    website?: string;
    description?: string;
    targetRegions?: string[];    // e.g. ["Udaipur, Rajasthan", "India"]
    primaryLanguage?: string;
    howDidYouHearAboutUs?: string;
  };

  // Step 2: Product & pricing
  product?: {
    whatItSells?: string;
    keyFeatures?: string;
    pricingTiers?: string;
    freeTrialAvailable?: boolean;
    lifetimeValuePerClient?: string;
  };

  // Step 3: Target customers
  customers?: {
    segments?: string[];          // e.g. ["Households", "Small businesses", "Hotels"]
    painPoints?: string;
    keywordsTheyUse?: string;
    topUseCases?: string;
  };

  // Step 4: Competition & differentiation
  competition?: {
    mainCompetitors?: string[];
    differentiation?: string;
    uniqueStrengths?: string;
    tradeOffs?: string;           // What you deliberately don't offer
    proof?: string;               // Evidence/claims that back up your strengths
  };

  // Step 5: Social proof & trust signals
  socialProof?: {
    caseStudies?: string;
    organicDiscussions?: string;  // Reddit threads, reviews, forums mentioning you
    socialMediaPresence?: string;
  };

  // Track which steps the user has completed
  completedSteps: number[]; // e.g. [1, 2, 3] means steps 1-3 done

  createdAt: Date;
  updatedAt: Date;
}

const BusinessContextSchema = new Schema<IBusinessContext>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      unique: true,
    },
    company: { type: Schema.Types.Mixed },
    product: { type: Schema.Types.Mixed },
    customers: { type: Schema.Types.Mixed },
    competition: { type: Schema.Types.Mixed },
    socialProof: { type: Schema.Types.Mixed },
    completedSteps: { type: [Number], default: [] },
  },
  { timestamps: true }
);

BusinessContextSchema.index({ projectId: 1 });

export const BusinessContext = mongoose.model<IBusinessContext>(
  "BusinessContext",
  BusinessContextSchema
);
