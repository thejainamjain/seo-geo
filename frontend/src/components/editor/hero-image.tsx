'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { logger } from '@/lib/logger';
import { ImageIcon, Upload, X, Loader2 } from 'lucide-react';

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_BYTES = 5 * 1024 * 1024; // mirrors backend's blogService.uploadImage limit

/**
 * A blog has exactly one image, whether it came from the pipeline
 * (Unsplash → Cloudinary, resolved at publish time) or a user upload here.
 * There is deliberately no "insert image" tool in RichTextEditor's
 * toolbar — this component is the only place an image can be set, so
 * "one image per blog" is a structural guarantee, not a rule someone has
 * to remember to enforce.
 */
export function HeroImage({
  url,
  onChange,
  uploadImage,
  editable,
}: {
  url:          string | null | undefined;
  onChange:     (url: string | null) => void;
  uploadImage:  (file: File) => Promise<string>;
  editable:     boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setError(null);

    if (!ALLOWED_TYPES.includes(file.type)) {
      const msg = `Unsupported image type: ${file.type}. Use PNG, JPEG, WebP, or GIF.`;
      logger.warn('Hero image upload rejected — invalid type', { type: file.type });
      setError(msg);
      return;
    }
    if (file.size > MAX_BYTES) {
      const msg = 'Image exceeds 5MB limit.';
      logger.warn('Hero image upload rejected — too large', { sizeBytes: file.size });
      setError(msg);
      return;
    }

    logger.debug('Hero image upload starting', { name: file.name, sizeBytes: file.size });
    setUploading(true);
    try {
      const newUrl = await uploadImage(file);
      logger.info('Hero image upload succeeded', { url: newUrl });
      onChange(newUrl);
    } catch (err) {
      logger.error('Hero image upload failed', {
        message: err instanceof Error ? err.message : String(err),
      });
      setError('Upload failed — try again.');
    } finally {
      setUploading(false);
    }
  }

  if (!editable) {
    if (!url) return null;
    return (
      <div className="relative w-full aspect-[2/1] rounded-lg overflow-hidden mb-6 bg-muted">
        <Image src={url} alt="" fill className="object-cover" />
      </div>
    );
  }

  return (
    <div className="mb-6">
      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_TYPES.join(',')}
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
          e.target.value = ''; // allow re-selecting the same file later
        }}
      />

      {url ? (
        <div className="relative w-full aspect-[2/1] rounded-lg overflow-hidden bg-muted group">
          <Image src={url} alt="" fill className="object-cover" />
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1.5" />}
              Replace
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={uploading}
              onClick={() => { logger.info('Hero image removed'); onChange(null); }}
            >
              <X className="h-3.5 w-3.5 mr-1.5" />
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
          className="w-full aspect-[3/1] rounded-lg border border-dashed border-border hover:border-muted-foreground/50 hover:bg-muted/30 transition-colors flex flex-col items-center justify-center gap-2 text-muted-foreground"
        >
          {uploading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <ImageIcon className="h-5 w-5" />
          )}
          <span className="text-xs">
            {uploading ? 'Uploading…' : 'Add hero image (PNG, JPEG, WebP, or GIF — max 5MB)'}
          </span>
        </button>
      )}

      {error && <p className="text-xs text-destructive mt-1.5">{error}</p>}
    </div>
  );
}
