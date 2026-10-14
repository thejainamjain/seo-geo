// lib/utils/safe-redirect.ts
//
// Validates the `?next=` value used to send people back to the page they
// originally wanted after logging in. Only same-site paths are allowed, so a
// crafted link can never redirect someone to another site after login (open
// redirect).

export function getSafeNext(next: string | null | undefined, fallback = '/projects'): string {
  if (!next) return fallback;
  // Must be a single-slash relative path. Reject "//evil.com", "/\evil.com",
  // absolute URLs, and anything with control characters.
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  if (/[\u0000-\u001f]/.test(next)) return fallback;
  // Never bounce back to an auth page (would loop).
  if (/^\/(login|register)(\/|\?|$)/.test(next)) return fallback;
  return next;
}
