/**
 * AES-256-GCM envelopes for the two kinds of secret held at rest (§9):
 *
 *  - Plaid access tokens, under TOKEN_ENCRYPTION_KEY.
 *  - Uploaded document bytes, under DOCUMENT_ENCRYPTION_KEY (Phase 2).
 *
 * Separate keys on purpose: a token dump and a document dump are different
 * blast radii, and either key should be rotatable without re-encrypting the
 * other. A bank statement is the most PII-dense object in the system.
 *
 * Format: IV (12) ‖ auth tag (16) ‖ ciphertext. Tokens store it base64; bytes
 * store it raw. Self-contained, so rotating storage never needs a side table.
 *
 * Upgrade path: swap `loadKey` for a KMS/secret-manager decrypt call. Nothing
 * else in the codebase touches the keys, so that change stays local to this file.
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

export type KeyName = 'TOKEN_ENCRYPTION_KEY' | 'DOCUMENT_ENCRYPTION_KEY';

/** Load and validate a 32-byte base64 key from the environment. */
export function loadKey(
  raw: string | undefined = process.env.TOKEN_ENCRYPTION_KEY,
  name: KeyName = 'TOKEN_ENCRYPTION_KEY',
): Buffer {
  if (!raw) {
    throw new EncryptionKeyError(
      `${name} is not set. Generate one with:\n` +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new EncryptionKeyError(
      `${name} must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        'It should be a base64-encoded 32-byte random value.',
    );
  }
  return key;
}

/** The document key. Refuses to be the token key, so the separation cannot erode by copy-paste. */
export function loadDocumentKey(raw: string | undefined = process.env.DOCUMENT_ENCRYPTION_KEY): Buffer {
  const key = loadKey(raw, 'DOCUMENT_ENCRYPTION_KEY');
  if (process.env.TOKEN_ENCRYPTION_KEY && raw === process.env.TOKEN_ENCRYPTION_KEY) {
    throw new EncryptionKeyError(
      'DOCUMENT_ENCRYPTION_KEY must differ from TOKEN_ENCRYPTION_KEY (§9): documents and ' +
        'tokens are separate blast radii and must be rotatable independently.',
    );
  }
  return key;
}

function seal(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function open(envelope: Buffer, key: Buffer, what: string): Buffer {
  if (envelope.length <= IV_BYTES + TAG_BYTES) {
    throw new EncryptionKeyError(`Encrypted ${what} is malformed or truncated.`);
  }
  const iv = envelope.subarray(0, IV_BYTES);
  const tag = envelope.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = envelope.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  // Throws if the tag does not verify — tampering and wrong-key both surface
  // here rather than yielding garbage plaintext.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptToken(plaintext: string, key: Buffer = loadKey()): string {
  return seal(Buffer.from(plaintext, 'utf8'), key).toString('base64');
}

export function decryptToken(envelope: string, key: Buffer = loadKey()): string {
  return open(Buffer.from(envelope, 'base64'), key, 'token').toString('utf8');
}

/** Encrypt document bytes for the DocumentStore (§9). */
export function encryptBytes(plaintext: Uint8Array, key: Buffer = loadDocumentKey()): Uint8Array {
  return seal(Buffer.from(plaintext), key);
}

export function decryptBytes(envelope: Uint8Array, key: Buffer = loadDocumentKey()): Uint8Array {
  return open(Buffer.from(envelope), key, 'document');
}
