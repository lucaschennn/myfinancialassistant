/**
 * The manual ledger end to end against real Postgres: typed entry → ledger →
 * `readManualSource` → `mergeSources` → `netWorth`. This is the first point the
 * Phase 2 thesis is testable — an account entered by hand appearing in a net
 * worth, with no Plaid item at all.
 *
 * Skips cleanly when no database is configured, like the user-store tests.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ManualLedgerError,
  archiveManualAccount,
  createManualAccount,
  getManualBalanceHistory,
  listAccounts,
  mergeSources,
  netWorth,
  recordManualBalance,
} from '@pfg/core';
import { type Database, closeDb, getDb, loadEnv, manualBalances, users } from '@pfg/db';
import { eq } from 'drizzle-orm';
import { hasManualAccounts, readManualSource } from './read.js';

loadEnv();
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('manual ledger: typed entry → snapshot', () => {
  let db: Database;
  let userId: string;
  let otherUserId: string;
  const ctx = () => ({ userId, db });

  beforeAll(async () => {
    db = getDb();
    const tag = `test-ledger-${Date.now()}`;
    const [u] = await db.insert(users).values({ email: `${tag}@example.test` }).returning({ id: users.id });
    const [o] = await db.insert(users).values({ email: `${tag}-other@example.test` }).returning({ id: users.id });
    userId = u!.id;
    otherUserId = o!.id;
  });

  afterAll(async () => {
    // Cascades remove every manual_* row and document these tests created.
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, otherUserId));
    await closeDb();
  });

  it('starts with no manual source and an empty result', async () => {
    expect(await hasManualAccounts(db, userId)).toBe(false);
    const r = await readManualSource({ userId, db, transactionWindow: { from: '2026-07-01', to: '2026-09-30' } });
    expect(r.accounts).toEqual([]);
    expect(r.transactionWindow).toBeNull();
  });

  it('a hand-entered checking account and card produce a net worth with no Plaid item', async () => {
    const checking = await createManualAccount(ctx(), {
      name: 'Credit Union Checking',
      type: 'depository',
      subtype: 'checking',
      mask: '4412',
      institutionName: 'Hometown CU',
      balance: { asOfDate: '2026-08-31', currentCents: 418_209n },
    });
    expect(checking.data.accountId).toMatch(/^manual_[0-9a-f-]{36}$/);

    // A liability is the POSITIVE amount owed, exactly as Plaid reports it.
    await createManualAccount(ctx(), {
      name: 'Store Card',
      type: 'credit',
      balance: { asOfDate: '2026-09-28', currentCents: 52_000n },
    });

    expect(await hasManualAccounts(db, userId)).toBe(true);

    const now = new Date('2026-10-05T12:00:00Z');
    const manual = await readManualSource({
      userId,
      db,
      transactionWindow: { from: '2026-07-07', to: '2026-10-05' },
    });
    const snapshot = mergeSources(userId, [manual], now);

    expect(snapshot.sources).toEqual(['manual']);
    expect(snapshot.accounts.map((a) => [a.name, a.source, a.currentCents, a.balanceAsOf])).toEqual([
      ['Credit Union Checking', 'manual', 418_209n, '2026-08-31'],
      ['Store Card', 'manual', 52_000n, '2026-09-28'],
    ]);

    const nw = netWorth({ userId, snapshot });
    expect(nw.data.assetsCents).toBe(418_209n);
    expect(nw.data.liabilitiesCents).toBe(52_000n);
    expect(nw.data.netWorthCents).toBe(366_209n);
    expect(nw.provenance.sources).toEqual(['manual']);
    // The August statement is five weeks older than the snapshot; the card is a week old.
    expect(nw.provenance.notes).toEqual([
      'From your own records: Credit Union Checking (…4412), entered by hand; Store Card, entered by hand.',
      "Credit Union Checking (…4412)'s balance is as of 2026-08-31, from your own records, " +
        'older than the rest of this snapshot (2026-10-05).',
    ]);

    const list = listAccounts({ userId, snapshot });
    expect(list.provenance.source).toBe('db');
    expect(list.data.accounts.every((a) => a.source === 'manual')).toBe(true);
  });

  it('a later balance becomes the current one, and the history keeps both', async () => {
    const manual = await readManualSource({ userId, db, transactionWindow: null });
    const checking = manual.accounts.find((a) => a.name === 'Credit Union Checking')!;

    await recordManualBalance(ctx(), { accountId: checking.accountId, asOfDate: '2026-09-30', currentCents: 390_000n });
    // Same date again corrects that day rather than adding a second row.
    await recordManualBalance(ctx(), { accountId: checking.accountId, asOfDate: '2026-09-30', currentCents: 391_050n });

    const after = await readManualSource({ userId, db, transactionWindow: null });
    expect(after.accounts.find((a) => a.accountId === checking.accountId)?.currentCents).toBe(391_050n);

    const history = await getManualBalanceHistory(ctx(), checking.accountId);
    expect(history.data.points.map((p) => [p.asOfDate, p.currentCents])).toEqual([
      ['2026-08-31', 418_209n],
      ['2026-09-30', 391_050n],
    ]);
  });

  it('rejects bad input rather than storing it', async () => {
    await expect(createManualAccount(ctx(), { name: 'X', type: 'savings' })).rejects.toThrow(ManualLedgerError);
    await expect(
      createManualAccount(ctx(), { name: 'X', type: 'depository', balance: { asOfDate: '2026-02-30', currentCents: 1n } }),
    ).rejects.toThrow('not a real calendar date');
    await expect(
      createManualAccount(ctx(), { name: 'X', type: 'depository', balance: { asOfDate: '2999-01-01', currentCents: 1n } }),
    ).rejects.toThrow('future');
    await expect(
      createManualAccount(ctx(), { name: 'X', type: 'depository', mask: '1234-5678-9012' }),
    ).rejects.toThrow('mask');
  });

  it('another user can neither see nor write these accounts', async () => {
    const mine = await readManualSource({ userId, db, transactionWindow: null });
    const theirs = await readManualSource({ userId: otherUserId, db, transactionWindow: null });
    expect(mine.accounts.length).toBeGreaterThan(0);
    expect(theirs.accounts).toEqual([]);

    const target = mine.accounts[0]!.accountId;
    await expect(
      recordManualBalance({ userId: otherUserId, db }, { accountId: target, asOfDate: '2026-09-01', currentCents: 1n }),
    ).rejects.toThrow('No such account');
    const archived = await archiveManualAccount({ userId: otherUserId, db }, target);
    expect(archived.data.archived).toBe(false);
  });

  it('archiving drops an account from the snapshot but keeps its history', async () => {
    const before = await readManualSource({ userId, db, transactionWindow: null });
    const card = before.accounts.find((a) => a.name === 'Store Card')!;
    expect((await archiveManualAccount(ctx(), card.accountId)).data.archived).toBe(true);

    const after = await readManualSource({ userId, db, transactionWindow: null });
    expect(after.accounts.map((a) => a.name)).toEqual(['Credit Union Checking']);

    const rows = await db.select().from(manualBalances).where(eq(manualBalances.userId, userId));
    expect(rows.length).toBe(3);
  });
});
