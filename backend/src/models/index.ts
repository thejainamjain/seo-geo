/**
 * models/index.ts — Central export for all 26 Mongoose collections.
 *
 * Import from here instead of individual files:
 *   import { User, Organization, Project, Blog } from "../models";
 *
 * ─────────────────────────────────────────────
 * COMPLETE COLLECTION LIST (26 total)
 * ─────────────────────────────────────────────
 *
 * ROUND 1 — Auth & Orgs
 *   User                   core auth identity
 *   EmailPreference        email opt-in/out per user
 *   Organization           tenant (individual or agency)
 *   OrganizationMember     user ↔ org join table with role
 *   OrganizationInvite     pending invitations to join an org
 *
 * ROUND 2 — Core Product
 *   Project                one domain being optimized (central model)
 *   GoogleToken            GSC OAuth tokens per project
 *   BusinessContext        5-step onboarding wizard data per project
 *   CmsConfig              CMS type + encrypted credentials + publish schedule
 *   ProjectKnowledgeFile   uploaded docs (PDFs, etc.) for AI context
 *   Audit                  one crawl run per project
 *
 * ROUND 3 — SEO Engine
 *   CodeChange             technical fix per page (title, alt, schema, etc.)
 *   InternalLink           internal linking suggestions
 *   FAQ                    AEO FAQ injections per page
 *   TLDR                   AEO summary injections per page
 *   CTA                    call-to-action injections per page
 *   ProjectCtaForm         reusable CTA form template per project
 *   Keyword                keyword research + content calendar entry
 *
 * ROUND 4 — Content Engine
 *   Blog                   AI-generated blog post (with embedded history[])
 *
 * ROUND 5 — Analytics & Advanced AI
 *   GeoAnalyticsRun        GEO score tracking per period
 *   BlogLearning           AI insights from GSC performance per blog
 *   BlogOptimization       proposed re-optimization per blog
 *   ProjectLearningChunk   vector embeddings for RAG (needs Atlas Vector Search)
 *
 * ROUND 6 — Agency & Enterprise
 *   SalesCallResearchRun   pre-call research reports for agency sales
 *   EnterpriseAuditRun     deep audits for enterprise prospects
 *   AuditLead              leads from public free audit page
 *
 * ROUND 7 — Operational
 *   EmailLog               every transactional email sent
 *   AppError               background job failure log
 *   ActivityLog            human-readable milestone feed for the Home dashboard
 */

// ── Round 1 ────────────────────────────────────────────────────────────────
export { User } from "./User";
export type { IUser } from "./User";

export { EmailPreference } from "./EmailPreference";
export type { IEmailPreference } from "./EmailPreference";

export { Organization } from "./Organization";
export type { IOrganization } from "./Organization";

export { OrganizationMember, OrganizationInvite } from "./OrganizationMember";
export type { IOrganizationMember, IOrganizationInvite } from "./OrganizationMember";

// ── Round 2 ────────────────────────────────────────────────────────────────
export { Project } from "./Project";
export type { IProject } from "./Project";

export { GoogleToken } from "./GoogleToken";
export type { IGoogleToken } from "./GoogleToken";

export { BusinessContext } from "./BusinessContext";
export type { IBusinessContext } from "./BusinessContext";

export { CmsConfig } from "./CmsConfig";
export type { ICmsConfig } from "./CmsConfig";

export { ProjectKnowledgeFile } from "./ProjectKnowledgeFile";
export type { IProjectKnowledgeFile } from "./ProjectKnowledgeFile";

export { Audit } from "./Audit";
export type { IAudit } from "./Audit";

// ── Round 3 ────────────────────────────────────────────────────────────────
export { CodeChange } from "./CodeChange";
export type { ICodeChange } from "./CodeChange";

export { InternalLink } from "./InternalLink";
export type { IInternalLink } from "./InternalLink";

export { FAQ } from "./FAQ";
export type { IFAQ } from "./FAQ";

export { TLDR } from "./TLDR";
export type { ITLDR } from "./TLDR";

export { CTA, ProjectCtaForm } from "./CTA";
export type { ICTA, IProjectCtaForm } from "./CTA";

export { Keyword } from "./Keyword";
export type { IKeyword } from "./Keyword";

// ── Round 4 ────────────────────────────────────────────────────────────────
export { Blog } from "./Blog";
export type { IBlog } from "./Blog";

// ── Round 5 ────────────────────────────────────────────────────────────────
export { GeoAnalyticsRun } from "./Analytics";
export type { IGeoAnalyticsRun } from "./Analytics";

export { BlogLearning, BlogOptimization, ProjectLearningChunk } from "./BlogLearning";
export type {
  IBlogLearning,
  IBlogOptimization,
  IProjectLearningChunk,
} from "./BlogLearning";

// ── Round 6 ────────────────────────────────────────────────────────────────
export { SalesCallResearchRun, EnterpriseAuditRun, AuditLead } from "./Analytics";
export type {
  ISalesCallResearchRun,
  IEnterpriseAuditRun,
  IAuditLead,
} from "./Analytics";

// ── Round 7 ────────────────────────────────────────────────────────────────
export { EmailLog, AppError } from "./Analytics";
export type { IEmailLog, IAppError } from "./Analytics";

export { ActivityLog, ACTIVITY_TYPE } from "./ActivityLog";
export type { IActivityLog, ActivityType } from "./ActivityLog";
