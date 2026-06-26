/**
 * models/OrganizationMember.ts
 *
 * WHO: A user's membership in an organization with a specific role.
 * A user can belong to multiple organizations (e.g. their own + a client's).
 *
 * WHY SEPARATE COLLECTION (not embedded in Organization):
 *   - Fast query: "which orgs does this user belong to?" → index on userId
 *   - Role updates don't touch Organization.updatedAt
 *   - Large agencies (100+ staff) won't bloat the Organization document
 *   - Simpler permission checks: findOne({ userId, organizationId }) vs $elemMatch
 *
 * ROLES:
 *   owner  → Created the org. Full control, manages billing, can delete org.
 *   admin  → Manages members, all projects, settings. Cannot delete org.
 *   member → Views and edits projects. Cannot manage members or billing.
 */

import mongoose, { Document, Schema, Types } from "mongoose";

export interface IOrganizationMember extends Document {
  userId: Types.ObjectId;
  organizationId: Types.ObjectId;
  role: "owner" | "admin" | "member";
  joinedAt: Date;
}

const OrganizationMemberSchema = new Schema<IOrganizationMember>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    role: {
      type: String,
      enum: ["owner", "admin", "member"],
      default: "member",
    },
    joinedAt: { type: Date, default: Date.now },
  },
  { timestamps: false } // joinedAt is enough, no need for createdAt/updatedAt
);

// A user can only have one role per org
OrganizationMemberSchema.index({ userId: 1, organizationId: 1 }, { unique: true });
OrganizationMemberSchema.index({ organizationId: 1 }); // "all members of this org"
OrganizationMemberSchema.index({ userId: 1 });          // "all orgs this user belongs to"

export const OrganizationMember = mongoose.model<IOrganizationMember>(
  "OrganizationMember",
  OrganizationMemberSchema
);

// ---------------------------------------------------------------------------

/**
 * models/OrganizationInvite.ts
 *
 * WHO: A pending invitation to join an organization.
 *
 * WHY SEPARATE COLLECTION (not embedded in Organization):
 *   - Invites are queried independently: "all pending invites for email X"
 *     (needed when the invited user signs up — check if they have pending invites)
 *   - Status updates (pending → accepted) don't touch Organization
 *   - Can expire old invites with a background job using the index on createdAt
 *
 * STATUS FLOW: pending → accepted | expired | revoked
 *
 * FLOW: Admin sends invite → doc created here (status: pending) →
 *       email sent with invite link → user clicks link →
 *       OrganizationMember created → this doc status set to "accepted"
 */

export interface IOrganizationInvite extends Document {
  organizationId: Types.ObjectId;
  email: string;
  role: "admin" | "member";
  status: "pending" | "accepted" | "expired" | "revoked";

  /** Who sent this invite — for display in the UI and audit trail */
  invitedById?: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const OrganizationInviteSchema = new Schema<IOrganizationInvite>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: ["admin", "member"], default: "member" },
    status: {
      type: String,
      enum: ["pending", "accepted", "expired", "revoked"],
      default: "pending",
    },
    invitedById: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

OrganizationInviteSchema.index({ organizationId: 1, status: 1 });
OrganizationInviteSchema.index({ email: 1, status: 1 }); // "pending invites for this email"
OrganizationInviteSchema.index({ createdAt: 1 });         // Background job: expire old invites

export const OrganizationInvite = mongoose.model<IOrganizationInvite>(
  "OrganizationInvite",
  OrganizationInviteSchema
);
