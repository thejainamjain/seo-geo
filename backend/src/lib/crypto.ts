/**
 * lib/crypto.ts
 *
 * AES-256-GCM encrypt/decrypt for CMS credentials stored in CmsConfig.
 * The ENCRYPTION_KEY env var is the only key — 32 bytes hex string.
 *
 * NEVER log encrypted or decrypted values.
 * NEVER expose this module to HTTP layer directly.
 */

import crypto from 'crypto';
import config from '@/utils/config';

const ALGORITHM  = 'aes-256-gcm';
const IV_LENGTH  = 12; // 96 bits — recommended for GCM
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const key = config.encryption.key();
  if (!key) throw new Error('ENCRYPTION_KEY is not defined');
  const buf = Buffer.from(key, 'hex');
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  return buf;
}

/**
 * Encrypt a plain-text string.
 * Returns a single base64 string: iv + authTag + ciphertext
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv  = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv) as crypto.CipherGCM;

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  // Pack: [iv (12)] + [tag (16)] + [ciphertext]
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypt a base64 string produced by encrypt().
 */
export function decrypt(ciphertext: string): string {
  const key  = getKey();
  const data = Buffer.from(ciphertext, 'base64');

  const iv         = data.subarray(0, IV_LENGTH);
  const tag        = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted  = data.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv) as crypto.DecipherGCM;
  decipher.setAuthTag(tag);

  return (
    decipher.update(encrypted).toString('utf8') +
    decipher.final('utf8')
  );
}
