/**
 * The document lifecycle (§7b): upload → parse → review → commit, plus reject
 * and delete. This is what the API routes call.
 *
 * The draft is never stored as the source of truth. What is stored is the
 * user's DECISIONS (and, for a PDF, the model's verbatim transcription, which
 * cannot be re-derived without another model call). Every read rebuilds the
 * draft from the encrypted original bytes, so the review screen, the commit,
 * and any later re-parse all see the same derivation.
 *
 * Every query is scoped by userId (§3), including the ones that start from a
 * document id — an id from a URL is user input.
 */

import type { TraceRecorder } from '@pfg/core';
import {
  type Database,
  type DocumentRow,
  documents,
  manualAccounts,
  manualBalances,
  manualHoldings,
  manualTransactions,
} from '@pfg/db';
import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm';
import { type CommitSummary, commitDraft } from './commit.js';
import { CsvParseError } from './csv/parse.js';
import { buildCsvDraft } from './csv/draft.js';
import { type Decisions, type Draft, type StoredDraft, draftView } from './draft.js';
import {
  type PdfTranscription,
  PdfTextError,
  TranscriptionFailedError,
  buildPdfDraft,
  extractPdfText,
} from './pdf/index.js';
import { type DocumentStore, LocalFileStore } from './store.js';
import { UploadRejectedError, decodeCsvText, findDuplicate, inspectUpload, storeUpload } from './upload.js';

export class DocumentNotFoundError extends Error {
  constructor() {
    super('No such document.');
    this.name = 'DocumentNotFoundError';
  }
}

/** The store for one user's documents. Phase 4 swaps this for a real blob store. */
export function documentStoreFor(userId: string): DocumentStore {
  return new LocalFileStore(userId);
}

interface Deps {
  db: Database;
  userId: string;
  store?: DocumentStore;
  trace?: TraceRecorder;
}

const timed = <T>(
  trace: TraceRecorder | undefined,
  scope: 'internal' | 'db' | 'anthropic',
  label: string,
  fn: () => Promise<T>,
  describe?: (v: T) => { count?: number; detail?: string },
): Promise<T> => (trace ? trace.track(scope, label, fn, describe) : fn());

async function loadRow(db: Database, userId: string, documentId: string): Promise<DocumentRow> {
  const [row] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.userId, userId)));
  if (!row) throw new DocumentNotFoundError();
  return row;
}

async function loadBytes(deps: Deps, row: DocumentRow): Promise<Uint8Array> {
  if (!row.storageKey) throw new DocumentNotFoundError();
  const store = deps.store ?? documentStoreFor(deps.userId);
  return timed(deps.trace, 'internal', 'read encrypted document', () => store.get(row.storageKey!), (b) => ({
    count: b.length,
    detail: 'bytes',
  }));
}

/**
 * Rebuild a draft from the original bytes and the stored decisions. Pure apart
 * from reading; for a PDF it re-extracts text (needed by the guard) but makes
 * no model call — the transcription was stored at parse time.
 */
export async function rebuildDraft(
  deps: Deps,
  row: DocumentRow,
  decisions: Decisions,
): Promise<{ draft: Draft; pages?: string[] }> {
  const bytes = await loadBytes(deps, row);
  if (row.kind === 'csv') {
    const { text, note } = decodeCsvText(bytes);
    const draft = await timed(deps.trace, 'internal', 'parse CSV', async () =>
      buildCsvDraft({ documentId: row.id, text, decisions }),
    (d) => ({ count: d.accounts[0]?.transactions.length ?? 0, detail: 'rows' }));
    if (note) draft.notes.unshift(note);
    return { draft };
  }
  const stored = (row.draftJson ?? {}) as StoredDraft;
  const pages = await timed(deps.trace, 'internal', 'extract PDF text', () => extractPdfText(bytes), (p) => ({
    count: p.length,
    detail: 'pages',
  }));
  const draft = buildPdfDraft({
    documentId: row.id,
    pages,
    transcription: stored.transcription as PdfTranscription,
    decisions,
  });
  return { draft, pages };
}

// ---------------------------------------------------------------------------
// Upload and parse
// ---------------------------------------------------------------------------

export type UploadOutcome =
  | { outcome: 'created'; documentId: string; status: string }
  | { outcome: 'duplicate'; documentId: string; status: string; committedAt: Date | null };

/**
 * Store a file and parse it into a draft awaiting review. A file this user has
 * already uploaded is recognised by its hash and not stored twice — a
 * duplicated statement is the most likely way a manual ledger gets a wrong net
 * worth (§7b).
 */
export async function uploadDocument(
  deps: Deps & {
    bytes: Uint8Array;
    filename: string | null;
    transcribe?: (pages: string[]) => Promise<PdfTranscription>;
  },
): Promise<UploadOutcome> {
  const inspection = inspectUpload(deps.bytes);
  const duplicate = await findDuplicate(deps.db, deps.userId, inspection.sha256);
  if (duplicate) {
    return { outcome: 'duplicate', documentId: duplicate.id, status: duplicate.status, committedAt: duplicate.committedAt };
  }
  const store = deps.store ?? documentStoreFor(deps.userId);
  const documentId = await timed(deps.trace, 'internal', 'encrypt and store document', () =>
    storeUpload({ db: deps.db, store, userId: deps.userId, bytes: deps.bytes, inspection, filename: deps.filename }),
  );
  const status = await parseDocument({ ...deps, store, documentId });
  return { outcome: 'created', documentId, status };
}

/** Parse a stored document into a reviewable draft. Never writes the ledger. */
export async function parseDocument(
  deps: Deps & { documentId: string; transcribe?: (pages: string[]) => Promise<PdfTranscription> },
): Promise<string> {
  const row = await loadRow(deps.db, deps.userId, deps.documentId);
  const fail = async (reason: string): Promise<string> => {
    await deps.db
      .update(documents)
      .set({ status: 'failed', failureReason: reason, draftJson: null })
      .where(and(eq(documents.id, row.id), eq(documents.userId, deps.userId)));
    return 'failed';
  };

  try {
    if (row.kind === 'csv') {
      await rebuildDraft(deps, row, {});
      const stored: StoredDraft = { decisions: {} };
      await deps.db
        .update(documents)
        .set({ status: 'needs_review', draftJson: stored, failureReason: null })
        .where(and(eq(documents.id, row.id), eq(documents.userId, deps.userId)));
      return 'needs_review';
    }

    // PDF: extract the text layer, then have a model transcribe verbatim
    // strings from it (§0.8). The guard runs when the draft is built.
    const bytes = await loadBytes(deps, row);
    const pages = await timed(deps.trace, 'internal', 'extract PDF text', () => extractPdfText(bytes), (p) => ({
      count: p.length,
      detail: 'pages',
    }));
    if (!deps.transcribe) return fail('PDF transcription is not configured on this server.');
    const transcription = await deps.transcribe(pages);
    const stored: StoredDraft = { decisions: {}, transcription };
    await deps.db
      .update(documents)
      .set({ status: 'needs_review', draftJson: stored, pageCount: pages.length, failureReason: null })
      .where(and(eq(documents.id, row.id), eq(documents.userId, deps.userId)));
    return 'needs_review';
  } catch (error) {
    if (error instanceof CsvParseError || error instanceof PdfTextError || error instanceof UploadRejectedError) {
      return fail(error.message);
    }
    if (row.kind === 'pdf') {
      // The model call failed or returned something unusable. The document is
      // kept as failed with a plain reason, so it can be thrown away and retried.
      const detail = error instanceof TranscriptionFailedError ? ` ${error.message}` : '';
      return fail(`The statement could not be read just now.${detail} Remove it and upload it again to retry.`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export interface ReviewState {
  document: {
    id: string;
    kind: string;
    status: string;
    filename: string | null;
    pageCount: number | null;
    failureReason: string | null;
    uploadedAt: string;
    committedAt: string | null;
  };
  view: ReturnType<typeof draftView> | null;
}

function documentMeta(row: DocumentRow): ReviewState['document'] {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    filename: row.originalFilename,
    pageCount: row.pageCount,
    failureReason: row.failureReason,
    uploadedAt: row.uploadedAt.toISOString(),
    committedAt: row.committedAt ? row.committedAt.toISOString() : null,
  };
}

/** The review screen's state: the document and its re-derived draft, as strings. */
export async function loadReview(deps: Deps & { documentId: string }): Promise<ReviewState> {
  const row = await loadRow(deps.db, deps.userId, deps.documentId);
  if (row.status !== 'needs_review') return { document: documentMeta(row), view: null };
  const stored = (row.draftJson ?? { decisions: {} }) as StoredDraft;
  const { draft } = await rebuildDraft(deps, row, stored.decisions);
  return { document: documentMeta(row), view: draftView(draft, stored.decisions) };
}

/** Replace the user's decisions, re-derive, store. Returns the new view. */
export async function updateDecisions(
  deps: Deps & { documentId: string; decisions: Decisions },
): Promise<ReviewState> {
  const row = await loadRow(deps.db, deps.userId, deps.documentId);
  if (row.status !== 'needs_review') return { document: documentMeta(row), view: null };
  const stored = (row.draftJson ?? { decisions: {} }) as StoredDraft;
  // Build first: decisions that cannot produce a draft are rejected, not stored.
  const { draft } = await rebuildDraft(deps, row, deps.decisions);
  const next: StoredDraft = { ...stored, decisions: deps.decisions };
  await deps.db
    .update(documents)
    .set({ draftJson: next })
    .where(and(eq(documents.id, row.id), eq(documents.userId, deps.userId)));
  return { document: documentMeta(row), view: draftView(draft, deps.decisions) };
}

/** Rebuild from the original bytes and commit. `commitDraft` re-checks every blocker. */
export async function commitDocument(deps: Deps & { documentId: string }): Promise<CommitSummary> {
  const row = await loadRow(deps.db, deps.userId, deps.documentId);
  if (row.status !== 'needs_review') throw new DocumentNotFoundError();
  const stored = (row.draftJson ?? { decisions: {} }) as StoredDraft;
  const { draft, pages } = await rebuildDraft(deps, row, stored.decisions);
  return timed(deps.trace, 'db', 'commit to your records', () =>
    commitDraft({ db: deps.db, userId: deps.userId, draft, decisions: stored.decisions, ...(pages ? { pages } : {}) }),
  );
}

/**
 * Throw a document away before it reaches the ledger. Rejecting is as easy as
 * committing: the bytes and the row both go, so the same file can be uploaded
 * again once whatever was wrong is fixed.
 */
export async function rejectDocument(deps: Deps & { documentId: string }): Promise<void> {
  const row = await loadRow(deps.db, deps.userId, deps.documentId);
  if (row.status === 'committed') throw new DocumentNotFoundError();
  await removeDocument(deps, row);
}

/**
 * Delete a committed document (§3). The choice is explicit:
 *  - `keep`: its rows stay in your records as free-standing entries.
 *  - `drop`: every balance, transaction and holding it contributed is removed,
 *    and any account it created that has nothing else left in it.
 * Either way the original bytes are deleted.
 */
export async function deleteDocument(
  deps: Deps & { documentId: string; ledger: 'keep' | 'drop' },
): Promise<{ rowsRemoved: number; accountsRemoved: number }> {
  const row = await loadRow(deps.db, deps.userId, deps.documentId);
  let rowsRemoved = 0;
  let accountsRemoved = 0;
  if (deps.ledger === 'drop') {
    await deps.db.transaction(async (tx) => {
      const txns = await tx
        .delete(manualTransactions)
        .where(and(eq(manualTransactions.userId, deps.userId), eq(manualTransactions.documentId, row.id)))
        .returning({ id: manualTransactions.id });
      const balances = await tx
        .delete(manualBalances)
        .where(and(eq(manualBalances.userId, deps.userId), eq(manualBalances.documentId, row.id)))
        .returning({ id: manualBalances.id });
      const holdings = await tx
        .delete(manualHoldings)
        .where(and(eq(manualHoldings.userId, deps.userId), eq(manualHoldings.documentId, row.id)))
        .returning({ id: manualHoldings.id });
      rowsRemoved = txns.length + balances.length + holdings.length;

      // Accounts this document created, now empty. One that also holds rows from
      // another document keeps them — dropping this file must not take those.
      const created = await tx
        .select({ id: manualAccounts.id })
        .from(manualAccounts)
        .where(and(eq(manualAccounts.userId, deps.userId), eq(manualAccounts.documentId, row.id)));
      for (const { id } of created) {
        const remaining = [
          ...(await tx.select({ id: manualTransactions.id }).from(manualTransactions).where(eq(manualTransactions.accountId, id)).limit(1)),
          ...(await tx.select({ id: manualBalances.id }).from(manualBalances).where(eq(manualBalances.accountId, id)).limit(1)),
          ...(await tx.select({ id: manualHoldings.id }).from(manualHoldings).where(eq(manualHoldings.accountId, id)).limit(1)),
        ];
        if (remaining.length === 0) {
          await tx.delete(manualAccounts).where(and(eq(manualAccounts.id, id), eq(manualAccounts.userId, deps.userId)));
          accountsRemoved += 1;
        }
      }
    });
  }
  await removeDocument(deps, row);
  return { rowsRemoved, accountsRemoved };
}

async function removeDocument(deps: Deps, row: DocumentRow): Promise<void> {
  // Rows that keep their figures lose only the reference (FK: on delete set null).
  await deps.db.delete(documents).where(and(eq(documents.id, row.id), eq(documents.userId, deps.userId)));
  if (row.storageKey) {
    const store = deps.store ?? documentStoreFor(deps.userId);
    await store.delete(row.storageKey);
  }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/** Every uploaded document, newest first. Typed-entry rows are not documents to the user. */
export async function listDocuments(db: Database, userId: string) {
  const rows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.userId, userId), ne(documents.kind, 'manual_entry')))
    .orderBy(desc(documents.uploadedAt));
  return rows.map(documentMeta);
}

/** Your live manual accounts, for "add these rows to an account I already have". */
export async function listManualAccountChoices(db: Database, userId: string) {
  const rows = await db
    .select({ id: manualAccounts.id, name: manualAccounts.name, mask: manualAccounts.mask, type: manualAccounts.type })
    .from(manualAccounts)
    .where(and(eq(manualAccounts.userId, userId), isNull(manualAccounts.archivedAt)))
    .orderBy(asc(manualAccounts.name));
  return rows.map((r) => ({ accountId: `manual_${r.id}`, name: r.name, mask: r.mask, type: r.type }));
}
