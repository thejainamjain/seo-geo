/**
 * lib/slug.ts — shared slug sanitizer.
 *
 * Extracted from workers/jobs/content-generation.job.ts's private copy so
 * services/blog.service.ts's user-facing slug-update path (see that
 * file's updateBlog) uses the exact same normalization rules, rather than
 * a second copy that could quietly drift out of sync.
 */
export function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}
