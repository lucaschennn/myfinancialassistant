import { describe, expect, it } from 'vitest';
import { assetAllocation } from './assetAllocation.js';
import { TEST_USER_ID, account, holding, security, snapshot, typicalSnapshot } from '../testing/fixtures.js';

const ctx = (snap = typicalSnapshot()) => ({ userId: TEST_USER_ID, snapshot: snap });

describe('assetAllocation', () => {
  it('totals holdings and splits them into asset classes', () => {
    const { data } = assetAllocation(ctx());

    expect(data.totalValueCents).toBe(15_230_040n);
    const byClass = Object.fromEntries(data.buckets.map((b) => [b.assetClass, b.valueCents]));
    expect(byClass.equity).toBe(4_000_000n);
    expect(byClass.fixed_income).toBe(2_000_000n);
    expect(byClass.cash).toBe(230_040n);
    // VTI is an ETF — a wrapper, not an asset class. See the note below.
    expect(byClass.other).toBe(9_000_000n);
  });

  it('sums the buckets back to the total', () => {
    const { data } = assetAllocation(ctx());
    const summed = data.buckets.reduce((acc, b) => acc + b.valueCents, 0n);
    expect(summed).toBe(data.totalValueCents);
  });

  it('reports shares in basis points, largest bucket first', () => {
    const { data } = assetAllocation(ctx());
    expect(data.buckets[0]?.assetClass).toBe('other');
    expect(data.buckets[0]?.shareBasisPoints).toBe(5909);
    expect(data.buckets.find((b) => b.assetClass === 'equity')?.shareBasisPoints).toBe(2626);
  });

  it('does not silently classify ETFs and mutual funds as equity', () => {
    const { data, provenance } = assetAllocation(ctx());
    const vti = data.holdings.find((h) => h.tickerSymbol === 'VTI');
    expect(vti?.assetClass).toBe('other');
    expect(provenance.notes?.join(' ')).toMatch(/ETFs and mutual funds/);
  });

  it('says out loud that checking/savings cash is not counted here', () => {
    const { provenance } = assetAllocation(ctx());
    expect(provenance.notes?.join(' ')).toMatch(/not included here/);
  });

  it('names investment accounts that returned no holdings', () => {
    const snap = snapshot({
      accounts: [
        account({ id: 'acct_ira', name: 'Old IRA', type: 'investment', current: 5_000, mask: '4321' }),
      ],
    });
    const { data, provenance } = assetAllocation(ctx(snap));

    expect(data.totalValueCents).toBe(0n);
    expect(provenance.notes?.join(' ')).toContain('Old IRA');
  });

  it('falls back to the cash-equivalent flag for unmapped security types', () => {
    const snap = snapshot({
      accounts: [account({ id: 'acct_inv', type: 'investment', current: 100 })],
      securities: [security({ id: 'sec_odd', type: 'some_new_plaid_type', isCashEquivalent: true })],
      holdings: [holding({ accountId: 'acct_inv', securityId: 'sec_odd', value: 100 })],
    });
    const { data } = assetAllocation(ctx(snap));
    expect(data.buckets[0]?.assetClass).toBe('cash');
  });

  it('filters to requested accounts', () => {
    const { data } = assetAllocation(ctx(), { accountIds: ['acct_nonexistent'] });
    expect(data.totalValueCents).toBe(0n);
    expect(data.holdings).toEqual([]);
  });

  it('returns null shares rather than dividing by zero on an empty portfolio', () => {
    const { data } = assetAllocation(ctx(snapshot()));
    expect(data.totalValueCents).toBe(0n);
    expect(data.buckets).toEqual([]);
  });
});
