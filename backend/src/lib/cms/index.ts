/**
 * lib/cms/index.ts
 *
 * Unified CMS publisher — single entry point for cms-publish.job.ts.
 *
 * USAGE:
 *   import { publishBlog } from '../lib/cms';
 *   const result = await publishBlog(cmsConfig, blog, domain, projectId);
 *
 * CREDENTIAL DECRYPTION:
 *   encryptedCredentials is decrypted here — only place outside crypto.ts
 *   that touches raw credentials. Never log decrypted values.
 *
 * CMS TYPE ROUTING:
 *   wordpress   → publishToWordPress
 *   squarespace → publishToWordPress (bridge WP install on our infra)
 *   webflow     → publishToWebflow
 *   framer      → publishToFramer
 *   wix         → publishToWix
 *   shopify     → publishToShopify
 *   sanity      → publishToSanity
 *   gohighlevel → publishToGoHighLevel
 *   custom_api  → publishToCustomApi
 *   other/null  → throws UnsupportedCmsError
 */

import { decrypt }              from '../crypto';
import { logger }               from '../../open-tele';
import { publishToWordPress }   from './wordpress';
import { publishToWebflow }     from './webflow';
import { publishToFramer }      from './framer';
import { publishToWix }         from './wix';
import { publishToShopify }     from './shopify';
import { publishToSanity }      from './sanity';
import { publishToGoHighLevel } from './gohighlevel';
import { publishToCustomApi }   from './custom-api';
import type {
  BlogPublishPayload,
  PublishResult,
  WordPressCredentials,
  WebflowCredentials,
  FramerCredentials,
  WixCredentials,
  ShopifyCredentials,
  SanityCredentials,
  SquarespaceCredentials,
  GoHighLevelCredentials,
  CustomApiCredentials,
} from './types';

export type { BlogPublishPayload, PublishResult };

// ── Credential decryption ──────────────────────────────────────────────────

function decryptCredentials<T>(encrypted: string, context: string): T {
  try {
    const json = decrypt(encrypted);
    return JSON.parse(json) as T;
  } catch (err) {
    throw new Error(
      `Failed to decrypt CMS credentials. Context: ${context}. ` +
      `Error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ── CmsConfig shape (minimal — only what we need here) ────────────────────

export interface CmsConfigForPublish {
  cmsType?:              string;
  encryptedCredentials?: string;
  blogPostPath:          string;
  autoPublish:           boolean;
  allowedPublishDays:    number[];
  publishHourUtc:        number;
}

// ── Main publish function ──────────────────────────────────────────────────

export async function publishBlog(
  cmsConfig:  CmsConfigForPublish,
  payload:    BlogPublishPayload,
  projectId:  string,
): Promise<PublishResult> {
  const { cmsType, encryptedCredentials } = cmsConfig;
  const context = `cms-publish:${projectId}:${payload.blogId}`;

  if (!cmsType) {
    throw new Error(`No cmsType set on CmsConfig. Context: ${context}`);
  }

  if (!encryptedCredentials) {
    throw new Error(`No encryptedCredentials on CmsConfig for cmsType: ${cmsType}. Context: ${context}`);
  }

  logger.info('Dispatching to CMS publisher', {
    context,
    cmsType,
    slug:  payload.slug,
    title: payload.title,
  });

  switch (cmsType) {
    case 'wordpress': {
      const creds = decryptCredentials<WordPressCredentials>(encryptedCredentials, context);
      return publishToWordPress(creds, payload, context);
    }

    case 'squarespace': {
      // Squarespace uses a WordPress bridge on our infrastructure.
      // Credentials are stored as WordPressCredentials pointing to our bridge WP install.
      // publishedUrl uses the user's domain, not the bridge URL.
      // See: CmsConfig.encryptedCredentials comment for full context.
      const creds = decryptCredentials<SquarespaceCredentials>(encryptedCredentials, context);
      return publishToWordPress(creds, payload, context);
    }

    case 'webflow': {
      const creds = decryptCredentials<WebflowCredentials>(encryptedCredentials, context);
      return publishToWebflow(creds, payload, context);
    }

    case 'framer': {
      const creds = decryptCredentials<FramerCredentials>(encryptedCredentials, context);
      return publishToFramer(creds, payload, context);
    }

    case 'wix': {
      const creds = decryptCredentials<WixCredentials>(encryptedCredentials, context);
      return publishToWix(creds, payload, context);
    }

    case 'shopify': {
      const creds = decryptCredentials<ShopifyCredentials>(encryptedCredentials, context);
      return publishToShopify(creds, payload, context);
    }

    case 'sanity': {
      const creds = decryptCredentials<SanityCredentials>(encryptedCredentials, context);
      return publishToSanity(creds, payload, context);
    }

    case 'gohighlevel': {
      const creds = decryptCredentials<GoHighLevelCredentials>(encryptedCredentials, context);
      return publishToGoHighLevel(creds, payload, context);
    }

    case 'custom_api': {
      const creds = decryptCredentials<CustomApiCredentials>(encryptedCredentials, context);
      return publishToCustomApi(creds, payload, context);
    }

    default: {
      throw new Error(
        `Unsupported CMS type: ${cmsType}. ` +
        `Supported types: wordpress, squarespace, webflow, framer, wix, shopify, sanity, gohighlevel, custom_api. ` +
        `Context: ${context}`
      );
    }
  }
}
