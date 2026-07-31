/**
 * lib/blog-content.ts
 *
 * WHAT: One small helper — stripLegacyHeroImagePlaceholder — plus the
 * reasoning for why it exists, so a future reader doesn't have to
 * reconstruct this from git blame.
 *
 * THE BUG THIS FIXES: constants/llm.constants.ts's BLOG_GENERATION_SYSTEM
 * prompt used to instruct the model to embed
 *   <div class="hero-image-container">...<img src="{{HERO_IMAGE_URL}}" ...
 * directly inside generated `content`, with the literal placeholder string
 * meant to be substituted with the real, resolved heroImageUrl later.
 * That substitution step was never implemented anywhere in the codebase
 * (checked every CMS publisher in lib/cms/*.ts — none of them touch
 * `content` for this; they all treat heroImageUrl as separate structured
 * metadata, e.g. WordPress's featured_media). So every blog generated
 * under the old prompt has a permanently broken <img> sitting in its body,
 * rendering as a broken-image icon in both our own editor/view and on
 * every CMS the blog gets published to.
 *
 * THE FIX: heroImageUrl is now the single source of truth for a blog's one
 * image, always rendered as a separate element by the frontend (see
 * components/editor/hero-image.tsx) — never embedded inline in `content`.
 * The generation prompt no longer asks the model to emit the container at
 * all. This helper is the other half: self-heals blogs generated under
 * the old prompt, by stripping the dead container out of `content` the
 * first time it's read, without a separate migration script.
 */

const HERO_IMAGE_CONTAINER_RE =
  /<div class="hero-image-container"[^>]*>[\s\S]*?<\/div>\s*/i;

export function stripLegacyHeroImagePlaceholder(content: string): { content: string; changed: boolean } {
  if (!content || !content.includes('hero-image-container')) {
    return { content, changed: false };
  }
  const cleaned = content.replace(HERO_IMAGE_CONTAINER_RE, '');
  return { content: cleaned, changed: cleaned !== content };
}
