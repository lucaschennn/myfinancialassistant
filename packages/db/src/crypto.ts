/**
 * AES-256-GCM envelope for Plaid access tokens at rest (§9).
 *
 * Format: base64( 12-byte IV ‖ 16-byte auth tag ‖ ciphertext ). Self-contained,
 * so rotating storage never needs a side table of IVs.
 *
 * Upgrade path: swap `loadKey` for a KMS/secret-manager decrypt call. Nothing
 * else in the codebase touches the key, so that change stays local to this file.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
  }
}

export function loadKey(raw = process.env.TOKEN_ENCRYPTION_KEY): Buffer {
  if (!raw) {
    throw new EncryptionKeyError(
      'TOKEN_ENCRYPTION_KEY is not set. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new EncryptionKeyError(
      `TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        'It should be a base64-encoded 32-byte random value.',
    );
  }
  return key;
}

export function encryptToken(plaintext: string, key: Buffer = loadKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptToken(envelope: string, key: Buffer = loadKey()): string {
  const buf = Buffer.from(envelope, 'base64');
  if (buf.length <= IV_BYTES + TAG_BYTES) {
    throw new EncryptionKeyError('Encrypted token is malformed or truncated.');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  // Throws if the tag does not verify — tampering and wrong-key both surface
  // here rather than yielding garbage plaintext.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
