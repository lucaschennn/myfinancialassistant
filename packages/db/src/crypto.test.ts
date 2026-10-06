import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { EncryptionKeyError, decryptBytes, encryptBytes, loadDocumentKey } from './crypto.js';

const saved = process.env.TOKEN_ENCRYPTION_KEY;
afterEach(() => {
  if (saved === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = saved;
});

describe('document encryption (§9)', () => {
  it('round-trips arbitrary bytes', () => {
    const key = randomBytes(32);
    const bytes = randomBytes(1000);
    expect(Buffer.from(decryptBytes(encryptBytes(bytes, key), key)).equals(bytes)).toBe(true);
  });

  it('names the missing variable', () => {
    expect(() => loadDocumentKey('')).toThrow('DOCUMENT_ENCRYPTION_KEY is not set');
  });

  it('refuses to reuse the token key', () => {
    const shared = randomBytes(32).toString('base64');
    process.env.TOKEN_ENCRYPTION_KEY = shared;
    expect(() => loadDocumentKey(shared)).toThrow(EncryptionKeyError);
    expect(() => loadDocumentKey(shared)).toThrow('must differ from TOKEN_ENCRYPTION_KEY');
    expect(loadDocumentKey(randomBytes(32).toString('base64')).length).toBe(32);
  });
});
