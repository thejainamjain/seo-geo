'use client';

// components/settings/image-config-dialog.tsx
//
// The "Image configuration" dialog — covers everything this app actually
// has for blog hero images: the uploaded pool (primary, no limit), a
// brand color (with real site auto-detection), and which of the two real
// fallback methods (text-card generation vs Unsplash) kicks in once the
// pool is empty. Deliberately not a clone of any richer reference UI with
// AI-generated images or a website-theme-scraping mode — those don't
// exist in this app, so they're not implied here either.
//
// Shared between the onboarding wizard's Blog Post Settings step and the
// Settings dashboard's Images card, so there's exactly one implementation
// to keep correct.

import { useRef, useState } from 'react';
import Image from 'next/image';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Loader2, X, ImageIcon, ImagePlus, Palette, Wand2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  usePoolImages, useUploadPoolImage, useDeletePoolImage,
  useProject, useUpdateProjectSettings, useDetectBrandColor,
} from '@/lib/hooks';

const DEFAULT_BRAND_COLOR = '#2563EB';
const HEX6_RE = /^#[0-9A-Fa-f]{6}$/;

// ── Color math ───────────────────────────────────────────────────────────
// Mirrors backend/src/lib/text-card-image.ts's deriveGradientStops exactly
// (same HSL lighten/darken shifts), so this live preview matches what the
// server will actually generate — not an approximation that could
// surprise the user once they publish.

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case r:  h = (g - b) / d + (g < b ? 6 : 0); break;
    case g:  h = (b - r) / d + 2; break;
    default: h = (r - g) / d + 4;
  }
  return { h: h * 60, s: s * 100, l: l * 100 };
}

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100, lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lN - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

function deriveGradientStops(hex: string): { light: string; dark: string } {
  const { h, s, l } = hexToHsl(hex);
  return {
    light: hslToHex(h, s, Math.min(l + 18, 88)),
    dark:  hslToHex(h, s, Math.max(l - 18, 12)),
  };
}

function TextCardPreview({ color }: { color: string }) {
  const { light, dark } = deriveGradientStops(color);
  const gradId = `preview-bg-${color.replace('#', '')}`;
  return (
    <svg viewBox="0 0 300 158" className="w-full h-auto rounded-md block">
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={dark} />
          <stop offset="100%" stopColor={light} />
        </linearGradient>
      </defs>
      <rect width="300" height="158" fill={`url(#${gradId})`} rx="8" />
      <circle cx="264" cy="20" r="45" fill="#FFFFFF" opacity="0.06" />
      <circle cx="24" cy="140" r="60" fill="#000000" opacity="0.08" />
      <text x="150" y="74" textAnchor="middle" fontSize="14" fontWeight="700" fill="#FFFFFF">Your Blog Post</text>
      <text x="150" y="93" textAnchor="middle" fontSize="14" fontWeight="700" fill="#FFFFFF">Title Goes Here</text>
    </svg>
  );
}

export function ImageConfigDialog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);

  const { data: project } = useProject(projectId);
  const { data: images, isLoading: imagesLoading } = usePoolImages(projectId);
  const uploadMut   = useUploadPoolImage(projectId);
  const deleteMut   = useDeletePoolImage(projectId);
  const settingsMut = useUpdateProjectSettings(projectId);
  const detectMut   = useDetectBrandColor(projectId);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const savedColor = (project?.brandColor && HEX6_RE.test(project.brandColor))
    ? project.brandColor
    : DEFAULT_BRAND_COLOR;

  const [colorDraft, setColorDraft] = useState(savedColor);
  const [detectFailed, setDetectFailed] = useState(false);

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      // Reset the draft to the saved value each time the dialog opens,
      // in case it changed elsewhere since it was last closed. Done here
      // rather than in a useEffect keyed on savedColor — that pattern
      // causes an extra render on every prop change instead of only the
      // one moment (open) that actually needs a reset.
      setColorDraft(savedColor);
      setDetectFailed(false);
    }
    setOpen(nextOpen);
  }

  const availableCount = images?.filter(img => img.status === 'available').length ?? 0;
  const hasImages = !!images && images.length > 0;
  const fallbackMode = project?.heroImageFallbackMode ?? 'unsplash';

  const colorValid   = HEX6_RE.test(colorDraft);
  const colorChanged = colorValid && colorDraft.toUpperCase() !== savedColor.toUpperCase();
  const previewColor = colorValid ? colorDraft : savedColor;

  function handleFile(file: File) {
    uploadMut.mutate(file);
  }

  function handleDetect() {
    setDetectFailed(false);
    detectMut.mutate(undefined, {
      onSuccess: (color) => {
        if (color) setColorDraft(color);
        else setDetectFailed(true);
      },
      onError: () => setDetectFailed(true),
    });
  }

  function handleSaveColor() {
    if (!colorValid) return;
    settingsMut.mutate({ brandColor: colorDraft });
  }

  function handleSelectFallbackMode(mode: 'unsplash' | 'text_card') {
    if (mode === fallbackMode) return;
    settingsMut.mutate({ heroImageFallbackMode: mode });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <button type="button" className="text-xs font-medium text-primary hover:underline shrink-0">
          Configure
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Image configuration</DialogTitle>
          <DialogDescription>
            Upload the images you want used as blog hero images, pick a brand color, and choose what happens once your uploads run out.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* ── Your images (pool) ── */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <ImageIcon className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Your images</span>
              <Badge variant="outline" className="text-xs">No limit</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{availableCount} available</span> to use next
              {hasImages && images!.some(img => img.status === 'used') && ' \u2014 images already used on a past blog are tagged below and won\u2019t be reused'}.
              {' '}We work through them in upload order, one per blog.
            </p>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={e => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
                e.target.value = '';
              }}
            />

            {!imagesLoading && !hasImages && (
              <p className="text-xs text-muted-foreground">No images added yet.</p>
            )}

            <div className="grid grid-cols-4 gap-2 max-h-64 overflow-y-auto pr-1">
              <button
                type="button"
                disabled={uploadMut.isPending}
                onClick={() => fileInputRef.current?.click()}
                className="aspect-square rounded-md border border-dashed border-border hover:border-muted-foreground/50 hover:bg-muted/30 transition-colors flex flex-col items-center justify-center gap-1 text-muted-foreground"
              >
                {uploadMut.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <ImagePlus className="h-5 w-5" />}
                <span className="text-[10px] text-center px-1">{uploadMut.isPending ? 'Uploading…' : 'Add image'}</span>
              </button>

              {imagesLoading && <div className="aspect-square rounded-md bg-muted animate-pulse" />}

              {images?.map(img => (
                <div key={img._id} className="relative aspect-square rounded-md overflow-hidden bg-muted group">
                  <Image src={img.url} alt="" fill className="object-cover" />
                  {img.status === 'used' && (
                    <Badge variant="secondary" className="absolute top-1 left-1 text-[10px] px-1 py-0">
                      Used
                    </Badge>
                  )}
                  <button
                    type="button"
                    onClick={() => deleteMut.mutate(img._id)}
                    disabled={deleteMut.isPending}
                    title="Remove"
                    className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100"
                  >
                    <X className="h-4 w-4 text-white" />
                  </button>
                </div>
              ))}
            </div>

            <p className="text-[11px] text-muted-foreground">PNG, JPEG, WebP, or GIF — max 5MB each.</p>
            {uploadMut.isError && <p className="text-xs text-destructive">Upload failed — try again.</p>}
          </div>

          <div className="h-px bg-border" />

          {/* ── Brand color ── */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Palette className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Brand color</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Used to theme the text-based fallback image below, and — if you turn on the default blog theme in Settings — your published blogs&apos; headings.
            </p>

            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="color"
                value={colorValid ? colorDraft : DEFAULT_BRAND_COLOR}
                onChange={e => setColorDraft(e.target.value.toUpperCase())}
                className="h-9 w-9 rounded border border-border cursor-pointer shrink-0 bg-transparent p-0"
                aria-label="Pick brand color"
              />
              <Input
                value={colorDraft}
                onChange={e => setColorDraft(e.target.value.toUpperCase())}
                placeholder="#2563EB"
                className="font-mono text-sm h-9 w-32"
                maxLength={7}
              />
              <Button type="button" variant="outline" size="sm" onClick={handleDetect} disabled={detectMut.isPending}>
                {detectMut.isPending
                  ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  : <Wand2 className="h-3.5 w-3.5 mr-1.5" />}
                Detect from site
              </Button>
              {colorChanged && (
                <Button type="button" size="sm" onClick={handleSaveColor} disabled={settingsMut.isPending}>
                  {settingsMut.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                  Save
                </Button>
              )}
            </div>

            {!colorValid && colorDraft.length > 0 && (
              <p className="text-xs text-destructive">Enter a 6-digit hex color, e.g. #2563EB.</p>
            )}
            {detectFailed && (
              <p className="text-xs text-muted-foreground">
                Couldn&apos;t detect a color automatically from your site — enter one manually above, or{' '}
                <button type="button" onClick={handleDetect} className="text-primary hover:underline">Retry</button>.
              </p>
            )}
          </div>

          <div className="h-px bg-border" />

          {/* ── Hero image fallback mode ── */}
          <div className="space-y-3">
            <span className="text-sm font-medium">When your uploads run out</span>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => handleSelectFallbackMode('text_card')}
                disabled={settingsMut.isPending}
                className={cn(
                  'rounded-lg border p-2 text-left transition-colors',
                  fallbackMode === 'text_card' ? 'border-foreground ring-1 ring-foreground' : 'border-border hover:bg-accent/30',
                )}
              >
                <TextCardPreview color={previewColor} />
                <p className="text-xs font-medium mt-2">Text-based images</p>
                <p className="text-[11px] text-muted-foreground">Generated from the title + your brand color</p>
              </button>

              <button
                type="button"
                onClick={() => handleSelectFallbackMode('unsplash')}
                disabled={settingsMut.isPending}
                className={cn(
                  'rounded-lg border p-2 text-left transition-colors',
                  fallbackMode === 'unsplash' ? 'border-foreground ring-1 ring-foreground' : 'border-border hover:bg-accent/30',
                )}
              >
                <div className="w-full aspect-[1.9/1] rounded-md bg-muted flex items-center justify-center">
                  <ImageIcon className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="text-xs font-medium mt-2">Stock images</p>
                <p className="text-[11px] text-muted-foreground">A relevant photo from Unsplash</p>
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
