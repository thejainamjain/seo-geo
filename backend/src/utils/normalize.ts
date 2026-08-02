/**
 * utils/normalize.ts
 *
 * WHY THIS EXISTS:
 *   BusinessContext.company/product/customers/competition are stored as
 *   Schema.Types.Mixed (see models/BusinessContext.ts) so the onboarding
 *   wizard's evolving field set doesn't require a migration every time a
 *   field is added or renamed. The trade-off is that Mongoose applies zero
 *   casting or validation to anything inside them — the IBusinessContext
 *   TypeScript interface (e.g. `targetRegions?: string[]`) is a compile-time
 *   promise only, not a runtime guarantee.
 *
 *   `company.targetRegions` was persisted as a raw comma-separated string
 *   instead of a string[] (see onboarding wizard's Step1Business, fixed
 *   alongside this file), which crashed both the Business settings page
 *   (`.join is not a function`) and the COMPETITOR_DISCOVERY pipeline step
 *   (serp.ts's deriveCountryCodeFromRegions).
 *
 *   normalizeToStringArray() is the single coercion used at:
 *     - the write path (project.service.ts's saveOnboardingStep), so no
 *       caller can persist a wrong shape going forward, and
 *     - the read paths that already exist in production and may still hold
 *       rows written before this fix (serp.ts, business-context-formatter.ts)
 *       so those degrade to "no data" instead of throwing.
 */
export function normalizeToStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map(v => v.trim());
  }
  if (typeof value === 'string') {
    return value.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}
