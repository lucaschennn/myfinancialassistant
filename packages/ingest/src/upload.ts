/**
 * Upload (§7b stage 1, §9).
 *
 * Split into PURE steps — sniff, hash, the duplicate check — and a separate
 * persist step, deliberately (PHASE-2-INGESTION §3, Phase 3 seam): the Phase 3
 * playground runs everything up to the draft on bytes in memory and must never
 * write, so nothing here may persist as a side effect of looking at a file.
 *
 * The filename and the browser's mime type are attacker-controlled (§9). The
 * kind of file is decided by its CONTENT, the size is capped, and the filename
 * is stored for display only — never as, or in, a storage path.
 */

import { createHash } from 'node:crypto';
import { type Database, documents } from '@pfg/db';
import { and, eq } from 'drizzle-orm';
import { type DocumentStore, newStorageKey } from './store.js';

/** Large enough for a year of statements in one export; small enough to reject garbage early. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export class UploadRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadRejectedError';
  }
}

export interface Inspection {
  kind: 'csv' | 'pdf';
  mimeType: 'text/csv' | 'application/pdf';
  byteSize: number;
  sha256: string;
}

const startsWith = (bytes: Uint8Array, ascii: string): boolean =>
  ascii.split('').every((ch, i) => bytes[i] === ch.charCodeAt(0));

/** Decide what a file is from its bytes alone. Pure. */
export function inspectUpload(bytes: Uint8Array): Inspection {
  if (bytes.length === 0) throw new UploadRejectedError('That file is empty.');
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new UploadRejectedError(`That file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  if (startsWith(bytes, '%PDF-')) {
    return { kind: 'pdf', mimeType: 'application/pdf', byteSize: bytes.length, sha256 };
  }
  if (startsWith(bytes, 'PK\u0003\u0004')) {
    throw new UploadRejectedError('Spreadsheet files are not supported. Export the account as CSV and upload that.');
  }
  // CSV is text: no NUL bytes in the head of the file is the cheapest honest test.
  // Whether it is actually a usable CSV is the parser's call, with a real reason.
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) {
    throw new UploadRejectedError('This is not a CSV export or a PDF statement, which are the two kinds of file accepted.');
  }
  return { kind: 'csv', mimeType: 'text/csv', byteSize: bytes.length, sha256 };
}

/** Bank CSVs are usually UTF-8, sometimes Windows-1252. Say which was used. */
export function decodeCsvText(bytes: Uint8Array): { text: string; note?: string } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return {
      text: new TextDecoder('windows-1252').decode(bytes),
      note: 'This file is not UTF-8, so it was read as Windows-1252. Check that names with accents look right.',
    };
  }
}

/** The existing document with these exact bytes, if this user already uploaded them. */
export async function findDuplicate(db: Database, userId: string, sha256: string) {
  const [existing] = await db
    .select({ id: documents.id, status: documents.status, uploadedAt: documents.uploadedAt, committedAt: documents.committedAt })
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.sha256, sha256)));
  return existing ?? null;
}

/** Persist the encrypted bytes and create the `documents` row. The only write in upload. */
export async function storeUpload(options: {
  db: Database;
  store: DocumentStore;
  userId: string;
  bytes: Uint8Array;
  inspection: Inspection;
  /** Display only. */
  filename: string | null;
}): Promise<string> {
  const { db, store, userId, bytes, inspection } = options;
  const storageKey = newStorageKey(userId);
  await store.put(storageKey, bytes);
  try {
    const [row] = await db
      .insert(documents)
      .values({
        userId,
        kind: inspection.kind,
        originalFilename: options.filename ? options.filename.slice(0, 200) : null,
        mimeType: inspection.mimeType,
        byteSize: inspection.byteSize,
        sha256: inspection.sha256,
        storageKey,
        status: 'uploaded',
      })
      .returning({ id: documents.id });
    return row!.id;
  } catch (error) {
    // No row means no owner for the bytes: remove them rather than orphan them.
    await store.delete(storageKey).catch(() => undefined);
    throw error;
  }
}
