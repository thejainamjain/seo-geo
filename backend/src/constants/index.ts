/**
 * constants/index.ts
 *
 * Shared constants used across the app.
 * Import from here instead of hardcoding strings in multiple places.
 */

// CMS types — must match cmsConfig.cmsType values in Project model
export const CMS_TYPES = [
  "wordpress",
  "webflow",
  "framer",
  "wix",
  "shopify",
  "sanity",
  "squarespace",
  "gohighlevel",
  "custom_api",
  "other",
] as const;

export type CmsType = typeof CMS_TYPES[number];

// Member roles
export const MEMBER_ROLES = ["owner", "admin", "member"] as const;
export type MemberRole = typeof MEMBER_ROLES[number];

// Max knowledge files per project (enforced in handler layer)
export const MAX_KNOWLEDGE_FILES = 25;

// Max blog history entries kept per blog
export const MAX_BLOG_HISTORY = 50;

// JWT expiry
export const JWT_EXPIRES_IN = "7d";

// DEPRECATED — this entire QUEUES object is unused anywhere in the
// codebase (verified by grep) — an older queue-naming scheme, fully
// superseded by QUEUE_NAMES in constants/seo-pipeline.constants.ts (the
// queue name strings here don't even match any real BullMQ queue in use —
// e.g. 'blog_generation' here vs the real 'seo-blog-generation' /
// 'seo-content-generation' etc.). Commented out rather than deleted;
// see deprecated/README.md.
// export const QUEUES = {
//   AUDIT: "audit",
//   BLOG_GENERATION: "blog_generation",
//   GEO_ANALYTICS: "geo_analytics",
//   CMS_PUBLISH: "cms_publish",
//   KNOWLEDGE_FILE_PROCESS: "knowledge_file_process",
//   BLOG_LEARNING: "blog_learning",
// } as const;

// Gemini models
export const GEMINI_MODELS = {
  PRIMARY: "gemini-2.0-flash",      // Fast, free tier — main generation model
  EMBEDDING: "text-embedding-004",  // 768 dimensions — for vector search
} as const;
