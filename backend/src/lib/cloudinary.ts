/**
 * lib/cloudinary.ts
 *
 * Cloudinary upload/delete helpers for knowledge file storage.
 */

import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a file buffer to Cloudinary.
 * Returns the secure URL and public_id.
 */
export async function uploadToCloudinary(
  buffer:   Buffer,
  filename: string,
  mimeType: string,
): Promise<{ url: string; publicId: string }> {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder:        'knowledge-files',
        public_id:     filename.replace(/\.[^/.]+$/, ''),
        resource_type: 'raw',
        format:        mimeType === 'application/pdf' ? 'pdf' : undefined,
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
 */
export async function deleteFromCloudinary(publicId: string): Promise<void> {
  await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });
}
