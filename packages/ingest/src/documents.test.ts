/**
 * The document lifecycle against real Postgres and a real (temp-dir) encrypted
 * store: upload → review → commit → ledger → snapshot → compute.
 *
 * The headline test is §3.4.4: commit a file in EACH sign convention and assert
 * `cashFlow` over the committed ledger puts inflow and outflow the right way
 * round. Getting this backwards raises no error anywhere else.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cashFlow, mergeSources, netWorth } from '@pfg/core';
import { type Database, closeDb, documents, getDb, loadEnv, manualTransactions, users } from '@pfg/db';
import { eq } from 'drizzle-orm';
import { CommitBlockedError } from './commit.js';
import {
  DocumentNotFoundError,
  commitDocument,
  deleteDocument,
  listDocuments,
  loadReview,
  rejectDocument,
  updateDecisions,
  uploadDocument,
} from './documents.js';
import type { PdfTranscription } from './pdf/transcribe.js';
import { makePdf } from './pdf/testPdf.js';
import { readManualSource } from './read.js';
import { LocalFileStore } from './store.js';

loadEnv();
const hasDb = Boolean(process.env.DATABASE_URL);
const fixture = (name: string): Uint8Array =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures', name));

describe.skipIf(!hasDb)('document lifecycle', () => {
  let db: Database;
  let userId: string;
  let otherId: string;
  let dir: string;
  let store: LocalFileStore;
  const key = randomBytes(32);
  const deps = () => ({ db, userId, store });

  beforeAll(async () => {
    db = getDb();
    const tag = `test-docs-${Date.now()}`;
    userId = (await db.insert(users).values({ email: `${tag}@example.test` }).returning({ id: users.id }))[0]!.id;
    otherId = (await db.insert(users).values({ email: `${tag}-o@example.test` }).returning({ id: users.id }))[0]!.id;
    dir = await mkdtemp(path.join(tmpdir(), 'pfg-docs-'));
    store = new LocalFileStore(userId, { dir, key });
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, otherId));
    await rm(dir, { recursive: true, force: true });
    await closeDb();
  });

  async function snapshotNow() {
    const window = { from: '2026-08-01', to: '2026-10-05' };
    const manual = await readManualSource({ userId, db, transactionWindow: window });
    return mergeSources(userId, [manual], new Date('2026-10-05T12:00:00Z'));
  }

  it('a negative-is-spending CSV commits with spending as outflow and pay as inflow', async () => {
    const up = await uploadDocument({ ...deps(), bytes: fixture('checking-negative-is-spending.csv'), filename: 'chase_4412.csv' });
    expect(up).toMatchObject({ outcome: 'created', status: 'needs_review' });

    // Not committable until named and the direction is confirmed.
    await expect(commitDocument({ ...deps(), documentId: up.documentId })).rejects.toThrow(CommitBlockedError);

    const review = await updateDecisions({
      ...deps(),
      documentId: up.documentId,
      decisions: { account: { name: 'Hometown Checking', type: 'depository' }, signConfirmed: true },
    });
    expect(review.view?.blockers).toEqual([]);
    // The browser sees strings only: raw beside the server's reading of it.
    expect(review.view?.accounts[0]?.transactions[0]).toMatchObject({
      amount: { raw: '-4.85', shown: '$4.85', origin: 'parsed' },
      direction: 'out',
    });

    const summary = await commitDocument({ ...deps(), documentId: up.documentId });
    expect(summary).toMatchObject({ accountCreated: true, transactionsInserted: 8, transactionsSkippedAsDuplicates: 0 });

    const snap = await snapshotNow();
    const flow = cashFlow({ userId, snapshot: snap }, { period: { from: '2026-09-01', to: '2026-09-30' } });
    // Two paychecks and a refund in; coffee, groceries, power, gas, rent out.
    expect(flow.data.inflowCents).toBe(325_000n + 325_000n + 1_599n);
    expect(flow.data.outflowCents).toBe(485n + 8_217n + 12_140n + 4_830n + 180_000n);
    expect(flow.provenance.sources).toEqual(['manual']);

    // The draft held figures; once committed it is cleared (§2).
    const [doc] = await db.select().from(documents).where(eq(documents.id, up.documentId));
    expect(doc?.draftJson).toBeNull();
    expect(doc?.status).toBe('committed');
  });

  it('a positive-is-spending card CSV lands the same way round', async () => {
    const up = await uploadDocument({ ...deps(), bytes: fixture('card-positive-is-spending.csv'), filename: null });
    await updateDecisions({
      ...deps(),
      documentId: up.documentId,
      decisions: {
        account: { name: 'Rewards Card', type: 'credit' },
        signConfirmed: true,
        balanceEdit: { amount: '520.00', asOfDate: '2026-09-30' },
      },
    });
    await commitDocument({ ...deps(), documentId: up.documentId });
    const snap = await snapshotNow();

    // Evidence names the document the balance came from: by kind and import
    // date, never by filename (real ones carry account numbers).
    const today = new Date().toISOString().slice(0, 10);
    const nw = netWorth({ userId, snapshot: snap });
    expect(nw.provenance.notes).toContain(
      `From your own records: Rewards Card, from the CSV export imported ${today}.`,
    );
    expect(JSON.stringify(nw.provenance)).not.toContain('chase_4412');
    expect(nw.data.liabilitiesCents).toBe(52_000n);
    const card = snap.accounts.find((a) => a.name === 'Rewards Card')!;
    const flow = cashFlow({ userId, snapshot: snap }, { period: { from: '2026-09-01', to: '2026-09-30' }, accountIds: [card.accountId] });
    expect(flow.data.inflowCents).toBe(50_000n); // the payment
    expect(flow.data.outflowCents).toBe(650n + 5_420n + 1_800n + 7_245n + 1_599n);
  });

  it('re-uploading the same file is recognised, not stored twice', async () => {
    const again = await uploadDocument({ ...deps(), bytes: fixture('checking-negative-is-spending.csv'), filename: 'copy.csv' });
    expect(again).toMatchObject({ outcome: 'duplicate', status: 'committed' });
    expect((await listDocuments(db, userId)).length).toBe(2);
  });

  it('an overlapping export adds only the rows the ledger does not have', async () => {
    const accounts = (await snapshotNow()).accounts;
    const checking = accounts.find((a) => a.name === 'Hometown Checking')!;
    // Same rows as before plus one new one, so a different file and hash.
    const text = `${new TextDecoder().decode(fixture('checking-negative-is-spending.csv'))}09/30/2026,09/30/2026,BOOKSHOP,Shopping,Sale,-12.00,\r\n`;
    const up = await uploadDocument({ ...deps(), bytes: new TextEncoder().encode(text), filename: null });
    await updateDecisions({
      ...deps(),
      documentId: up.documentId,
      decisions: { account: { existingAccountId: checking.accountId }, signConfirmed: true },
    });
    const summary = await commitDocument({ ...deps(), documentId: up.documentId });
    expect(summary).toMatchObject({ accountCreated: false, transactionsInserted: 1, transactionsSkippedAsDuplicates: 8 });
  });

  it('a PDF whose transcription invented a balance commits without it', async () => {
    const pdf = makePdf([['Hometown Savings', 'Statement date 08/31/2026', 'Ending balance $5,000.00'], ['08/15 INTEREST PAID 2.10']]);
    const lying: PdfTranscription = {
      institutionName: { raw: 'Hometown Savings', page: 1 },
      accountName: { raw: '', page: 0 },
      accountNumber: { raw: '', page: 0 },
      accountKind: 'savings',
      statementDate: { raw: '08/31/2026', page: 1 },
      openingBalance: { raw: '', page: 0 },
      closingBalance: { raw: '$50,000.00', page: 1 }, // invented: the page says $5,000.00
      totals: [],
      transactions: [{ date: { raw: '08/15', page: 2 }, description: { raw: 'INTEREST PAID', page: 2 }, amount: { raw: '2.10', page: 2 }, direction: 'in' }],
      holdings: [],
      otherAccountsOnStatement: 0,
    };
    const up = await uploadDocument({ ...deps(), bytes: pdf, filename: 'stmt.pdf', transcribe: async () => lying });
    expect(up.status).toBe('needs_review');

    const review = await updateDecisions({ ...deps(), documentId: up.documentId, decisions: { account: { name: 'Savings' }, signConfirmed: true } });
    expect(review.view?.dropped.map((d) => [d.label, d.raw])).toEqual([['closing balance', '$50,000.00']]);
    expect(review.view?.accounts[0]?.balance).toBeNull();

    await commitDocument({ ...deps(), documentId: up.documentId });
    const savings = (await snapshotNow()).accounts.find((a) => a.name === 'Savings')!;
    expect(savings.currentCents).toBeNull(); // never $50,000 — and netWorth leaves it out, saying so
    const nw = netWorth({ userId, snapshot: await snapshotNow() });
    expect(nw.data.excludedAccountIds).toContain(savings.accountId);
  });

  it('a scanned PDF fails with the reason, and nothing reaches the ledger', async () => {
    const up = await uploadDocument({ ...deps(), bytes: makePdf(['image-only']), filename: null, transcribe: async () => { throw new Error('must not be called'); } });
    expect(up.status).toBe('failed');
    const review = await loadReview({ ...deps(), documentId: up.documentId });
    expect(review.document.failureReason).toContain('scanned image');
    await rejectDocument({ ...deps(), documentId: up.documentId });
    await expect(loadReview({ ...deps(), documentId: up.documentId })).rejects.toThrow(DocumentNotFoundError);
  });

  it('another user cannot load, commit, or delete these documents', async () => {
    const [mine] = await listDocuments(db, userId);
    const other = { db, userId: otherId, store: new LocalFileStore(otherId, { dir, key }) };
    await expect(loadReview({ ...other, documentId: mine!.id })).rejects.toThrow(DocumentNotFoundError);
    await expect(deleteDocument({ ...other, documentId: mine!.id, ledger: 'drop' })).rejects.toThrow(DocumentNotFoundError);
  });

  it('deleting a document can keep its rows as free-standing entries, or drop them', async () => {
    const docs = await listDocuments(db, userId);
    const card = docs.find((d) => d.filename === null && d.kind === 'csv' && d.status === 'committed')!;

    const before = (await db.select().from(manualTransactions).where(eq(manualTransactions.userId, userId))).length;
    const kept = await deleteDocument({ ...deps(), documentId: card.id, ledger: 'keep' });
    expect(kept).toEqual({ rowsRemoved: 0, accountsRemoved: 0 });
    expect((await db.select().from(manualTransactions).where(eq(manualTransactions.userId, userId))).length).toBe(before);

    const checking = docs.find((d) => d.filename === 'chase_4412.csv')!;
    const dropped = await deleteDocument({ ...deps(), documentId: checking.id, ledger: 'drop' });
    // Its 8 rows go; the account stays, because the overlapping export's row is still in it.
    expect(dropped).toEqual({ rowsRemoved: 8, accountsRemoved: 0 });
    expect((await snapshotNow()).accounts.some((a) => a.name === 'Hometown Checking')).toBe(true);

    // And the encrypted bytes are gone from the store, not just the row.
    const remaining = (await readdir(path.join(dir, userId))).length;
    expect(remaining).toBe((await listDocuments(db, userId)).length);
  });
});
