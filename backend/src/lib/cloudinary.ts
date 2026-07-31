import { v2 as cloudinary } from 'cloudinary';
import config from '../utils/config';

cloudinary.config({
  cloud_name: config.cloudinary.cloudName(),
api_key:    config.cloudinary.apiKey(),
api_secret: config.cloudinary.apiSecret(),
});

export interface CloudinaryUploadOptions {
  /** Cloudinary folder — keeps different upload sources cleanly separated. */
  folder: string;
  /** 'raw' for documents (PDF/txt/etc, not natively previewable by
   *  Cloudinary's image pipeline), 'image' for actual images (gets real
   *  image processing — format detection, transformations, etc). */
  resourceType: 'raw' | 'image';
  /** Only meaningful for resourceType 'raw' — Cloudinary needs an explicit
   *  format hint for non-image files it can't sniff on its own. */
  format?: string;
}

/**
 * Upload a file buffer to Cloudinary.
 * Returns the secure URL and public_id.
 */
export async function uploadToCloudinary(
  buffer:   Buffer,
  filename: string,
  options:  CloudinaryUploadOptions,
): Promise<{ url: string; publicId: string }> {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder:        options.folder,
        public_id:     filename.replace(/\.[^/.]+$/, ''),
        resource_type: options.resourceType,
        format:        options.format,
      },
      (error, result) => {
        if (error || !result) return reject(error ?? new Error('Cloudinary upload failed'));
        resolve({ url: result.secure_url, publicId: result.public_id });
      },
    );
    uploadStream.end(buffer);
  });
}

/**
 * Delete a file from Cloudinary by its public_id.
 * resourceType must match what the file was uploaded as, or Cloudinary
 * won't find it (raw and image live in separate namespaces there).
 */
export async function deleteFromCloudinary(
  publicId:     string,
  resourceType: 'raw' | 'image' = 'raw',
): Promise<void> {
  await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
}
