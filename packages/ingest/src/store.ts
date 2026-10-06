/**
 * Where uploaded document bytes live (§2, §9). Never Postgres, never the repo.
 *
 * Keys are server-generated and opaque — `${userId}/${uuid}` — and NEVER derived
 * from an uploaded filename: a filename is attacker-controlled, and `../` is a
 * path. Every read asserts the key belongs to the requesting user, so a mixed-up
 * document id is a thrown error rather than someone else's bank statement.
 *
 * `LocalFileStore` is for local development only. Vercel's filesystem does not
 * survive a request, so Phase 4 supplies a real blob store behind this same
 * interface (CLAUDE.md §2, §8 Phase 4).
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decryptBytes, encryptBytes, loadEnv } from '@pfg/db';

export interface DocumentStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class StorageKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageKeyError';
  }
}

/** A fresh opaque key for this user. The only way keys are made. */
export function newStorageKey(userId: string): string {
  if (!UUID.test(userId)) throw new StorageKeyError('A storage key needs a user uuid.');
  return `${userId}/${randomUUID()}`;
}

/**
 * Assert a key is well-formed and belongs to `userId`. Called on every access.
 * Two uuids and one slash, nothing else — which also rules out traversal.
 */
export function assertOwnedKey(key: string, userId: string): void {
  const [owner, object, ...rest] = key.split('/');
  if (rest.length > 0 || !owner || !object || !UUID.test(owner) || !UUID.test(object)) {
    throw new StorageKeyError('Malformed document storage key.');
  }
  if (owner !== userId) {
    throw new StorageKeyError('Document storage key does not belong to this user. Refusing to read it.');
  }
}

function defaultDir(): string {
  if (process.env.DOCUMENT_STORE_DIR) return path.resolve(process.env.DOCUMENT_STORE_DIR);
  // Same root the .env was found in, so the location does not depend on cwd.
  const envFile = loadEnv();
  return path.join(envFile ? path.dirname(envFile) : process.cwd(), '.documents');
}

/**
 * Encrypted files on local disk. A `DocumentStore` bound to one user: it can
 * only put, get, or delete keys under that user's prefix.
 */
export class LocalFileStore implements DocumentStore {
  private readonly dir: string;

  constructor(
    private readonly userId: string,
    options: { dir?: string; key?: Buffer } = {},
  ) {
    this.dir = options.dir ?? defaultDir();
    this.key = options.key;
  }

  private readonly key: Buffer | undefined;

  private pathFor(key: string): string {
    assertOwnedKey(key, this.userId);
    const [owner, object] = key.split('/') as [string, string];
    return path.join(this.dir, owner, `${object}.bin`);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const file = this.pathFor(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, this.key ? encryptBytes(bytes, this.key) : encryptBytes(bytes));
  }

  async get(key: string): Promise<Uint8Array> {
    const envelope = await readFile(this.pathFor(key));
    return this.key ? decryptBytes(envelope, this.key) : decryptBytes(envelope);
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
