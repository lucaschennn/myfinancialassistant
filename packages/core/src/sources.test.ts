import { describe, expect, it } from 'vitest';
import { netWorth } from './compute/netWorth.js';
import { fireProgress } from './compute/fireProgress.js';
import { spendingByCategory } from './compute/spendingByCategory.js';
import { listAccounts } from './tools/aggregation.js';
import {
  DuplicateAccountIdError,
  type SourceResult,
  isManualAccountId,
  manualAccountId,
  manualUuid,
  mergeSources,
} from './sources.js';
import { staleAccounts } from './snapshot.js';
import {
  TEST_USER_ID,
  account,
  holding,
  security,
  snapshot,
  transaction,
} from './testing/fixtures.js';

const NOW = new Date('2026-10-05T12:00:00.000Z');

function source(kind: SourceResult['kind'], over: Partial<SourceResult> = {}): SourceResult {
  return {
    kind,
    accounts: [],
    holdings: [],
    securities: [],
    transactions: [],
    transactionWindow: null,
    gaps: [],
    ...over,
  };
}

describe('manual ids', () => {
  it('prefix a uuid so it cannot collide with a Plaid id, and round-trip', () => {
    const id = manualAccountId('0b9d6f2e-1111-4222-8333-444455556666');
    expect(id).toBe('manual_0b9d6f2e-1111-4222-8333-444455556666');
    expect(isManualAccountId(id)).toBe(true);
    expect(isManualAccountId('BxBXxLj1m4HMXBm9WZZmCWVbPjX16EHwv99vp')).toBe(false);
    expect(manualUuid(id)).toBe('0b9d6f2e-1111-4222-8333-444455556666');
    expect(manualUuid('acct_checking')).toBeNull();
  });
});

describe('mergeSources', () => {
  it('rule 1: throws on an account id present in two sources rather than deduping', () => {
    const plaid = source('plaid', { accounts: [account({ id: 'dup', type: 'depository', current: 10 })] });
    const manual = source('manual', {
      accounts: [account({ id: 'dup', type: 'depository', current: 10, source: 'manual' })],
    });
    expect(() => mergeSources(TEST_USER_ID, [plaid, manual], NOW)).toThrow(DuplicateAccountIdError);
  });

  it('rule 2: the transaction window is the intersection, and the wider range is stated', () => {
    const plaid = source('plaid', {
      accounts: [account({ id: 'p1', type: 'depository', current: 10 })],
      transactionWindow: { from: '2026-07-07', to: '2026-10-05' },
      transactions: [
        transaction({ accountId: 'p1', date: '2026-07-10', amount: 5 }),
        transaction({ accountId: 'p1', date: '2026-10-01', amount: 7 }),
      ],
    });
    const manual = source('manual', {
      accounts: [account({ id: 'manual_a', type: 'depository', current: 10, source: 'manual' })],
      transactionWindow: { from: '2026-01-01', to: '2026-08-31' },
      transactions: [
        transaction({ accountId: 'manual_a', date: '2026-02-14', amount: 99, source: 'manual' }),
        transaction({ accountId: 'manual_a', date: '2026-08-20', amount: 12, source: 'manual' }),
      ],
    });

    const snap = mergeSources(TEST_USER_ID, [plaid, manual], NOW);

    expect(snap.transactionWindow).toEqual({ from: '2026-07-07', to: '2026-08-31' });
    // Outside the intersection on either side: the Feb manual row and the Oct Plaid row.
    expect(snap.transactions.map((t) => t.date).sort()).toEqual(['2026-07-10', '2026-08-20']);
    const reasons = snap.gaps.map((g) => g.reason);
    expect(reasons).toContain(
      'Plaid also cover 2026-07-07 to 2026-10-05, but only 2026-07-07 to 2026-08-31 is covered ' +
        'by every source, so only that period is used.',
    );
    expect(reasons).toContain(
      'Your own records also cover 2026-01-01 to 2026-08-31, but only 2026-07-07 to ' +
        '2026-08-31 is covered by every source, so only that period is used.',
    );
  });

  it('rule 2: disjoint windows leave no window and say why', () => {
    const snap = mergeSources(
      TEST_USER_ID,
      [
        source('plaid', {
          accounts: [account({ id: 'p1', type: 'depository', current: 1 })],
          transactionWindow: { from: '2026-09-01', to: '2026-10-05' },
        }),
        source('manual', {
          accounts: [account({ id: 'manual_a', type: 'depository', current: 1, source: 'manual' })],
          transactionWindow: { from: '2026-01-01', to: '2026-03-31' },
        }),
      ],
      NOW,
    );
    expect(snap.transactionWindow).toBeNull();
    expect(snap.transactions).toEqual([]);
    expect(snap.gaps.some((g) => g.reason.includes('do not overlap'))).toBe(true);
  });

  it('rule 2: an empty source does not narrow the window', () => {
    const snap = mergeSources(
      TEST_USER_ID,
      [
        source('plaid', {
          accounts: [account({ id: 'p1', type: 'depository', current: 1 })],
          transactionWindow: { from: '2026-07-07', to: '2026-10-05' },
        }),
        source('manual', { transactionWindow: { from: '2026-09-01', to: '2026-09-30' } }),
      ],
      NOW,
    );
    expect(snap.transactionWindow).toEqual({ from: '2026-07-07', to: '2026-10-05' });
    expect(snap.sources).toEqual(['plaid']);
  });

  it('rule 3: securities dedupe by id', () => {
    const vti = security({ id: 'sec_vti', ticker: 'VTI', type: 'etf' });
    const snap = mergeSources(
      TEST_USER_ID,
      [
        source('plaid', {
          accounts: [account({ id: 'p1', type: 'investment', current: 1 })],
          securities: [vti],
          holdings: [holding({ accountId: 'p1', securityId: 'sec_vti', value: 1 })],
        }),
        source('plaid', { securities: [vti] }),
      ],
      NOW,
    );
    expect(snap.securities.map((s) => s.securityId)).toEqual(['sec_vti']);
  });

  it('rules 4 and 5: sources lists kinds with accounts; gaps keep their source', () => {
    const snap = mergeSources(
      TEST_USER_ID,
      [
        source('plaid', {
          gaps: [
            { source: 'plaid', itemId: 'i', institutionName: 'Bank', dataset: 'balances', reason: 'down' },
          ],
        }),
        source('manual', {
          accounts: [account({ id: 'manual_a', type: 'depository', current: 1, source: 'manual' })],
          gaps: [
            { source: 'manual', itemId: 'doc', institutionName: null, dataset: 'documents', reason: 'unreadable' },
          ],
        }),
      ],
      NOW,
    );
    expect(snap.sources).toEqual(['manual']);
    expect(snap.gaps.map((g) => [g.source, g.reason])).toEqual([
      ['plaid', 'down'],
      ['manual', 'unreadable'],
    ]);
    expect(snap.fetchedAt).toBe('2026-10-05T12:00:00.000Z');
  });

  it('a user with nothing connected gets an empty snapshot', () => {
    const snap = mergeSources(TEST_USER_ID, [], NOW);
    expect(snap.sources).toEqual([]);
    expect(snap.accounts).toEqual([]);
    expect(snap.transactionWindow).toBeNull();
  });
});

describe('staleness across sources', () => {
  // A Plaid balance fetched on the snapshot date, beside a manual balance from
  // a statement five weeks earlier.
  const mixed = () =>
    snapshot({
      fetchedAt: '2026-10-05T12:00:00.000Z',
      accounts: [
        account({
          id: 'p_checking',
          name: 'Plaid Checking',
          mask: '0000',
          type: 'depository',
          current: 1_000,
          balanceAsOf: '2026-10-05T12:00:00.000Z',
        }),
        account({
          id: 'manual_savings',
          name: 'Credit Union Savings',
          mask: '4412',
          type: 'depository',
          current: 5_000,
          source: 'manual',
          balanceAsOf: '2026-08-31',
        }),
        account({
          id: 'manual_recent',
          name: 'Recent Statement',
          mask: '9999',
          type: 'depository',
          current: 50,
          source: 'manual',
          balanceAsOf: '2026-10-01',
        }),
      ],
    });

  it('flags only balances older than seven days', () => {
    expect(staleAccounts(mixed()).map((a) => a.accountId)).toEqual(['manual_savings']);
  });

  it('netWorth names the stale account and its date, and both sources', () => {
    const { data, provenance } = netWorth({ userId: TEST_USER_ID, snapshot: mixed() });
    expect(data.netWorthCents).toBe(605_000n);
    expect(provenance.sources).toEqual(['plaid', 'manual']);
    expect(provenance.notes).toContain(
      "Credit Union Savings (…4412)'s balance is as of 2026-08-31, from your own records, " +
        'older than the rest of this snapshot (2026-10-05).',
    );
    // A week-old balance is named as yours, but not called older than the rest.
    expect(provenance.notes?.some((n) => n.includes('Recent Statement') && n.includes('older than'))).toBe(false);
    expect(provenance.notes).toContain(
      'From your own records: Credit Union Savings (…4412), entered by hand; Recent Statement (…9999), entered by hand.',
    );
  });

  it('fireProgress carries the same staleness note', async () => {
    const { provenance } = await fireProgress(
      { userId: TEST_USER_ID, snapshot: mixed() },
      { annualSpendCents: 4_000_000n },
    );
    expect(provenance.notes).toContain(
      "Credit Union Savings (…4412)'s balance is as of 2026-08-31, from your own records, " +
        'older than the rest of this snapshot (2026-10-05).',
    );
    expect(provenance.sources).toEqual(['plaid', 'manual']);
  });

  it('a Plaid-only snapshot has no staleness notes and says it is from Plaid', () => {
    const snap = snapshot({ accounts: [account({ type: 'depository', current: 10 })] });
    const nw = netWorth({ userId: TEST_USER_ID, snapshot: snap });
    expect(nw.provenance.notes).toBeUndefined();
    expect(nw.provenance.sources).toEqual(['plaid']);
    const list = listAccounts({ userId: TEST_USER_ID, snapshot: snap });
    expect(list.provenance.source).toBe('plaid');
    expect(list.provenance.computation).toBe('Every account from Plaid (fetched live).');
  });

  it('a manual-only snapshot is read from the ledger, not "from Plaid"', () => {
    const snap = snapshot({
      accounts: [account({ id: 'manual_x', type: 'depository', current: 10, source: 'manual' })],
    });
    const list = listAccounts({ userId: TEST_USER_ID, snapshot: snap });
    expect(list.provenance.source).toBe('db');
    expect(list.provenance.sources).toEqual(['manual']);
    expect(list.provenance.computation).toBe(
      'Every account from your own records (statements and typed entries).',
    );
  });
});

describe('spendingByCategory uncategorised wording', () => {
  const period = { from: '2026-07-01', to: '2026-07-31' };

  it('does not claim a CSV row arrived from Plaid', () => {
    const snap = snapshot({
      accounts: [account({ id: 'manual_a', type: 'depository', current: 1, source: 'manual' })],
      transactions: [transaction({ accountId: 'manual_a', date: '2026-07-04', amount: 20, source: 'manual' })],
    });
    const { provenance } = spendingByCategory({ userId: TEST_USER_ID, snapshot: snap }, { period });
    expect(provenance.notes).toContain(
      'Some transactions came from your own records without a category and are grouped as UNCATEGORIZED.',
    );
    expect(provenance.notes?.some((n) => n.includes('Plaid'))).toBe(false);
  });

  it('names both origins when both contributed uncategorised rows', () => {
    const snap = snapshot({
      accounts: [
        account({ id: 'p1', type: 'depository', current: 1 }),
        account({ id: 'manual_a', type: 'depository', current: 1, source: 'manual' }),
      ],
      transactions: [
        transaction({ accountId: 'p1', date: '2026-07-04', amount: 20 }),
        transaction({ accountId: 'manual_a', date: '2026-07-05', amount: 30, source: 'manual' }),
      ],
    });
    const { provenance } = spendingByCategory({ userId: TEST_USER_ID, snapshot: snap }, { period });
    expect(provenance.notes).toContain(
      'Some transactions arrived from Plaid without a category or came from your own records ' +
        'without a category and are grouped as UNCATEGORIZED.',
    );
  });
});

describe('staleness boundary', () => {
  const at = (balanceAsOf: string) =>
    staleAccounts(
      snapshot({
        fetchedAt: '2026-10-05T23:59:00.000Z',
        accounts: [account({ type: 'depository', current: 1, source: 'manual', balanceAsOf })],
      }),
    ).length;

  it('counts calendar days: exactly 7 is fresh, 8 is stale, whatever the fetch time', () => {
    expect(at('2026-09-28')).toBe(0);
    expect(at('2026-09-27')).toBe(1);
  });
});
