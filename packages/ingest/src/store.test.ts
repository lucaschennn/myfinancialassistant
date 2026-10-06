import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalFileStore, StorageKeyError, assertOwnedKey, newStorageKey } from './store.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const key = randomBytes(32);
const dirs: string[] = [];

async function store(userId = USER): Promise<{ s: LocalFileStore; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pfg-store-'));
  dirs.push(dir);
  return { s: new LocalFileStore(userId, { dir, key }), dir };
}

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('LocalFileStore', () => {
  it('round-trips bytes and stores only ciphertext on disk', async () => {
    const { s, dir } = await store();
    const k = newStorageKey(USER);
    const plaintext = new TextEncoder().encode('Date,Amount\n2026-08-01,-4.85 STARBUCKS #4412\n');
    await s.put(k, plaintext);

    expect(Buffer.from(await s.get(k)).toString('utf8')).toBe(Buffer.from(plaintext).toString('utf8'));

    const [ownerDir] = await readdir(dir);
    const [file] = await readdir(path.join(dir, ownerDir!));
    const onDisk = await readFile(path.join(dir, ownerDir!, file!));
    expect(onDisk.includes(Buffer.from('STARBUCKS'))).toBe(false);
    expect(onDisk.length).toBe(plaintext.length + 12 + 16);
  });

  it('refuses a key outside the user prefix', async () => {
    const { s } = await store();
    await expect(s.get(`${OTHER}/${randomUUID()}`)).rejects.toThrow(StorageKeyError);
    await expect(s.put(`${OTHER}/${randomUUID()}`, new Uint8Array([1]))).rejects.toThrow(
      'does not belong to this user',
    );
  });

  it('refuses traversal and filename-shaped keys', () => {
    for (const bad of [
      `${USER}/../${OTHER}/${randomUUID()}`,
      `${USER}/statement_4412.pdf`,
      `../../etc/passwd`,
      `${USER}`,
    ]) {
      expect(() => assertOwnedKey(bad, USER)).toThrow('Malformed');
    }
  });

  it('cannot decrypt with a different key', async () => {
    const { s, dir } = await store();
    const k = newStorageKey(USER);
    await s.put(k, new Uint8Array([1, 2, 3]));
    const wrong = new LocalFileStore(USER, { dir, key: randomBytes(32) });
    await expect(wrong.get(k)).rejects.toThrow();
  });

  it('delete removes the bytes', async () => {
    const { s } = await store();
    const k = newStorageKey(USER);
    await s.put(k, new Uint8Array([9]));
    await s.delete(k);
    await expect(s.get(k)).rejects.toThrow();
  });
});
