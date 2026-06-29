/**
 * lib/cms/types.ts
 *
 * Shared types for all CMS publishers.
 * Every publisher receives DecryptedCmsCredentials + BlogPublishPayload
 * and returns PublishResult.
 */

// ── Decrypted credential shapes per CMS type ──────────────────────────────
// These match the shapes documented in CmsConfig.encryptedCredentials comment.

export interface WordPressCredentials {
  siteUrl:             string;
  username:            string;
  applicationPassword: string;
}

export interface WebflowCredentials {
  apiToken:       string;
  collectionId:   string; // Webflow CMS collection ID for blog posts
}

export interface FramerCredentials {
  projectId: string;
}

export interface WixCredentials {
  apiKey: string;
  siteId: string;
}

export interface ShopifyCredentials {
  storeName:   string;
  accessToken: string;
}

export interface SanityCredentials {
  projectId:   string;
  datasetName: string;
  apiToken:    string;
}

export interface SquarespaceCredentials extends WordPressCredentials {
  // Squarespace uses a WordPress bridge provisioned on our infrastructure.
  // Credentials are identical to WordPress — siteUrl points to our bridge WP install.
  // The only difference: siteUrl is ours, not the user's.
  // See: CmsConfig.ts comment on encryptedCredentials for context.
  xmlExportUrl?: string; // optional — URL to download XML for manual Squarespace import
}

export interface GoHighLevelCredentials {
  privateIntegrationToken: string;
  blogDashboardUrl:        string; // app.gohighlevel.com/v2/location/.../blogs/site/...
}

export interface CustomApiCredentials {
  endpointUrl: string;
  authHeader:  string; // e.g. "Bearer token123"
}

// ── Blog publish payload ───────────────────────────────────────────────────

export interface BlogPublishPayload {
  blogId:      string;
  title:       string;
  slug:        string;
  description: string;
  content:     string;       // Full HTML content
  heroImageUrl?: string;
  seoSchema?:  Record<string, unknown>;
  blogPostPath: string;      // e.g. "blog" → publishedUrl = domain/blog/slug
  domain:      string;       // project domain — for building publishedUrl
}

// ── Publish result ─────────────────────────────────────────────────────────

export interface PublishResult {
  success:      boolean;
  cmsReference: string;   // ID from CMS (WP post ID, Webflow item ID, etc.)
  publishedUrl: string;   // Full URL of the published post
  error?:       string;   // Only set if success: false
}
