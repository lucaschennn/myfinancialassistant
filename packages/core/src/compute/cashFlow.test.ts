import { describe, expect, it } from 'vitest';
import { cashFlow } from './cashFlow.js';
import { savingsRate } from './savingsRate.js';
import { TEST_USER_ID, snapshot, transaction, typicalSnapshot } from '../testing/fixtures.js';

const ctx = (snap = typicalSnapshot()) => ({ userId: TEST_USER_ID, snapshot: snap });
const JULY = { from: '2026-07-01', to: '2026-07-31' };

describe('cashFlow', () => {
  it('inverts Plaid\'s sign so both sides are positive magnitudes', () => {
    const { data } = cashFlow(ctx(), { period: JULY });

    expect(data.inflowCents).toBe(1_300_000n); // two -6,500 paychecks
    expect(data.outflowCents).toBe(292_675n);
    expect(data.netCents).toBe(1_007_325n);
    expect(data.transactionCount).toBe(6);
  });

  it('excludes internal transfers so they are not counted twice', () => {
    const { data, provenance } = cashFlow(ctx(), { period: JULY });
    expect(data.outflowCents).toBe(292_675n); // the $1,500 TRANSFER_OUT is absent
    expect(provenance.notes?.join(' ')).toMatch(/transfer\(s\) between your own accounts/);
  });

  it('includes transfers when asked', () => {
    const { data } = cashFlow(ctx(), { period: JULY, excludeTransfers: false });
    expect(data.outflowCents).toBe(442_675n);
  });

  it('excludes pending transactions by default and says how many', () => {
    const { data, provenance } = cashFlow(ctx(), { period: JULY });
    expect(data.transactionCount).toBe(6);
    expect(provenance.notes?.join(' ')).toMatch(/1 pending transaction/);

    const withPending = cashFlow(ctx(), { period: JULY, includePending: true });
    expect(withPending.data.outflowCents).toBe(301_674n);
  });

  it('respects the date range boundaries inclusively', () => {
    const snap = snapshot({
      transactions: [
        transaction({ date: '2026-06-30', amount: 10 }),
        transaction({ date: '2026-07-01', amount: 20 }),
        transaction({ date: '2026-07-31', amount: 30 }),
        transaction({ date: '2026-08-01', amount: 40 }),
      ],
    });
    const { data } = cashFlow(ctx(snap), { period: JULY });
    expect(data.outflowCents).toBe(5_000n); // 20 + 30 only
  });

  it('warns when the requested period reaches outside the fetched window', () => {
    const { provenance } = cashFlow(ctx(), { period: { from: '2024-01-01', to: '2026-07-31' } });
    expect(provenance.notes?.join(' ')).toMatch(/only fetched back to 2026-05-03/);
  });

  it('rejects relative period shorthand — that is the router\'s job', () => {
    expect(() =>
      cashFlow(ctx(), { period: { from: 'current_month', to: 'now' } as never }),
    ).toThrow(/explicit YYYY-MM-DD/);
  });

  it('rejects a backwards range', () => {
    expect(() => cashFlow(ctx(), { period: { from: '2026-07-31', to: '2026-07-01' } })).toThrow(
      /is after/,
    );
  });

  it('filters to specific accounts', () => {
    const { data } = cashFlow(ctx(), { period: JULY, accountIds: ['acct_nonexistent'] });
    expect(data.inflowCents).toBe(0n);
    expect(data.outflowCents).toBe(0n);
  });
});

describe('savingsRate', () => {
  it('is (income − spend) ÷ income in basis points', () => {
    const { data } = savingsRate(ctx(), { period: JULY });

    expect(data.incomeCents).toBe(1_300_000n);
    expect(data.spendCents).toBe(292_675n);
    expect(data.savedCents).toBe(1_007_325n);
    expect(data.savingsRateBasisPoints).toBe(7748); // 77.48%
  });

  it('reconciles exactly with cashFlow over the same period', () => {
    const flow = cashFlow(ctx(), { period: JULY });
    const rate = savingsRate(ctx(), { period: JULY });

    expect(rate.data.incomeCents).toBe(flow.data.inflowCents);
    expect(rate.data.spendCents).toBe(flow.data.outflowCents);
    expect(rate.data.savedCents).toBe(flow.data.netCents);
  });

  it('goes negative when spending exceeds income instead of clamping', () => {
    const snap = snapshot({
      transactions: [
        transaction({ date: '2026-07-01', amount: -1_000, primary: 'INCOME' }),
        transaction({ date: '2026-07-05', amount: 1_500, primary: 'FOOD_AND_DRINK' }),
      ],
    });
    const { data } = savingsRate(ctx(snap), { period: JULY });

    expect(data.savedCents).toBe(-50_000n);
    expect(data.savingsRateBasisPoints).toBe(-5000); // −50%
  });

  it('returns null and explains itself when no income was seen', () => {
    const snap = snapshot({
      transactions: [transaction({ date: '2026-07-05', amount: 100, primary: 'FOOD_AND_DRINK' })],
    });
    const { data, provenance } = savingsRate(ctx(snap), { period: JULY });

    expect(data.savingsRateBasisPoints).toBeNull();
    expect(provenance.notes?.join(' ')).toMatch(/not linked/);
  });
});
