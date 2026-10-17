/**
 * utils/business-sections.ts
 *
 * Validation + merging for the Business page's per-section save
 * (PATCH /projects/:projectId/business/:section).
 *
 * Each section writes ONLY the fields it is given, as dotted paths
 * ("competition.differentiation"), so it can never wipe sibling data the page
 * doesn't show (competitor entries, competitor insights, `proof`, …).
 */

export const BUSINESS_SECTIONS = ['company', 'product', 'customers', 'competition', 'socialProof'] as const;
export type BusinessSection = typeof BUSINESS_SECTIONS[number];

type FieldSpec =
  | { kind: 'string';      max: number }
  | { kind: 'stringArray'; maxItems: number; maxLen: number }
  | { kind: 'domains';     maxItems: number };

const TEXT = (max: number): FieldSpec => ({ kind: 'string', max });

const SPECS: Record<BusinessSection, Record<string, FieldSpec>> = {
  company: {
    name: TEXT(200), website: TEXT(500), description: TEXT(5000),
    targetRegions: { kind: 'stringArray', maxItems: 50, maxLen: 100 },
  },
  product: {
    whatItSells: TEXT(2000), keyFeatures: TEXT(10000), pricingTiers: TEXT(5000),
  },
  customers: {
    segments: { kind: 'stringArray', maxItems: 50, maxLen: 200 },
    painPoints: TEXT(10000), keywordsTheyUse: TEXT(10000), topUseCases: TEXT(10000),
  },
  competition: {
    mainCompetitors: { kind: 'domains', maxItems: 30 },
    differentiation: TEXT(5000), uniqueStrengths: TEXT(5000), proof: TEXT(5000), tradeOffs: TEXT(5000),
  },
  socialProof: {
    caseStudies: TEXT(5000), organicDiscussions: TEXT(5000), socialMediaPresence: TEXT(5000),
  },
};

/** "https://www.Example.com/path?x=1" → "example.com". Returns '' if it isn't a plausible domain. */
export function normalizeDomain(raw: string): string {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  d = d.replace(/^www\./, '');
  d = d.split(/[/?#]/)[0] ?? '';
  d = d.replace(/:\d+$/, '').replace(/\.$/, '');
  // \p{M} (combining marks) is needed for scripts such as Devanagari, where vowel signs are marks, not letters.
  const valid = /^(?=.{3,253}$)([\p{L}\p{M}\p{N}]([\p{L}\p{M}\p{N}-]{0,61}[\p{L}\p{M}\p{N}])?\.)+[\p{L}\p{M}]{2,63}$/u.test(d);
  return valid ? d : '';
}

export type SectionValidation =
  | { ok: true;  section: BusinessSection; value: Record<string, unknown> }
  | { ok: false; error: string };

export function validateBusinessSection(section: string, data: unknown): SectionValidation {
  if (!(BUSINESS_SECTIONS as readonly string[]).includes(section)) {
    return { ok: false, error: `Unknown business section "${section}"` };
  }
  const sec = section as BusinessSection;

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'data must be an object' };
  }

  const spec = SPECS[sec];
  const input = data as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length === 0) return { ok: false, error: 'No fields to save' };

  const value: Record<string, unknown> = {};

  for (const key of keys) {
    const field = spec[key];
    if (!field) return { ok: false, error: `Unknown field "${key}" for section ${sec}` };
    const raw = input[key];

    if (field.kind === 'string') {
      if (typeof raw !== 'string') return { ok: false, error: `${sec}.${key} must be a string` };
      if (raw.length > field.max)  return { ok: false, error: `${sec}.${key} is too long (max ${field.max} characters)` };
      value[key] = raw.trim();
      continue;
    }

    if (!Array.isArray(raw) || raw.some(item => typeof item !== 'string')) {
      return { ok: false, error: `${sec}.${key} must be a list of text values` };
    }
    const items = (raw as string[]).map(s => s.trim()).filter(Boolean);

    if (field.kind === 'stringArray') {
      if (items.length > field.maxItems) return { ok: false, error: `${sec}.${key} has too many items (max ${field.maxItems})` };
      if (items.some(s => s.length > field.maxLen)) return { ok: false, error: `${sec}.${key} has an item that is too long (max ${field.maxLen} characters)` };
      value[key] = items;
      continue;
    }

    // domains
    const domains: string[] = [];
    for (const item of items) {
      const domain = normalizeDomain(item);
      if (!domain) return { ok: false, error: `"${item}" is not a valid domain` };
      if (!domains.includes(domain)) domains.push(domain);
    }
    if (domains.length > field.maxItems) return { ok: false, error: `${sec}.${key} has too many domains (max ${field.maxItems})` };
    value[key] = domains;
  }

  return { ok: true, section: sec, value };
}

/**
 * Applies the user's edited competitor list to the stored entries:
 *   - a domain that already has an entry KEEPS that entry untouched
 *     (verified flag, SERP snippet, crawl outcome, relevance verdict …)
 *   - a new domain becomes a user-entered, unverified entry
 *   - a domain the user removed is dropped
 * Order follows the submitted list.
 */
export function mergeCompetitors(
  existing: unknown,
  submittedDomains: string[],
  now: Date,
): { entries: Array<Record<string, unknown>>; kept: Set<string> } {
  const byDomain = new Map<string, Record<string, unknown>>();
  if (Array.isArray(existing)) {
    for (const item of existing) {
      if (item && typeof item === 'object' && typeof (item as { domain?: unknown }).domain === 'string') {
        const entry = item as Record<string, unknown>;
        byDomain.set(normalizeDomain(entry.domain as string) || (entry.domain as string), entry);
      } else if (typeof item === 'string') {
        const domain = normalizeDomain(item);
        if (domain && !byDomain.has(domain)) {
          byDomain.set(domain, { domain, source: 'user', verified: false, addedAt: now });
        }
      }
    }
  }

  const entries: Array<Record<string, unknown>> = [];
  const kept = new Set<string>();
  for (const domain of submittedDomains) {
    if (kept.has(domain)) continue;
    kept.add(domain);
    entries.push(byDomain.get(domain) ?? { domain, source: 'user', verified: false, addedAt: now });
  }
  return { entries, kept };
}
