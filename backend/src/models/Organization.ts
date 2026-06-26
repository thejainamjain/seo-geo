/**
 * models/Organization.ts
 *
 * WHO: The tenant unit of the entire platform.
 *
 * KEY ARCHITECTURE DECISION:
 *   Individual user  = Organization { type: "individual" } with 1 member
 *   Agency           = Organization { type: "agency" } with multiple members
 *
 * WHY ONE MODEL: Avoids maintaining two separate permission systems.
 * When an individual wants to add a team member, we just add an
 * OrganizationMember row — no schema changes, no permission rewrites.
 *
 * NOTHING EMBEDDED HERE — members and invites are separate collections:
 *   OrganizationMember → models/OrganizationMember.ts
 *   OrganizationInvite → models/OrganizationInvite.ts
 *
 * WHY NOT EMBEDDED:
 *   - Members array can grow large for big agencies (100+ staff)
 *   - Invite list is queried independently ("all pending invites for this org")
 *   - Member role updates shouldn't touch the Organization.updatedAt
 *   - Easier to query "which orgs does user X belong to?" via OrganizationMember
 *     than doing $elemMatch on every Organization document
 */

import mongoose, { Document, Schema } from "mongoose";

export interface IOrganization extends Document {
  name: string;

  /**
   * individual → solo user or small team managing their own site(s)
   * agency     → manages multiple client projects under one umbrella
   */
  type: "individual" | "agency";

  // Agency white-labeling — shown to clients when white-label is enabled
  brandColor?: string;
  logoUrl?: string;

  createdAt: Date;
  updatedAt: Date;
}

const OrganizationSchema = new Schema<IOrganization>(
  {
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ["individual", "agency"],
      default: "individual",
    },
    brandColor: { type: String },
    logoUrl: { type: String },
  },
  { timestamps: true }
);

export const Organization = mongoose.model<IOrganization>(
  "Organization",
  OrganizationSchema
);
