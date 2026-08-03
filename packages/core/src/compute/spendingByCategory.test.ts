import { describe, expect, it } from 'vitest';
import { spendingByCategory } from './spendingByCategory.js';
import { TEST_USER_ID, snapshot, transaction, typicalSnapshot } from '../testing/fixtures.js';

const ctx = (snap = typicalSnapshot()) => ({ userId: TEST_USER_ID, snapshot: snap });
const JULY = { from: '2026-07-01', to: '2026-07-31' };

describe('spendingByCategory', () => {
  it('groups outflows by Plaid\'s primary category, largest first', () => {
    const { data } = spendingByCategory(ctx(), { period: JULY });

    expect(data.totalSpendCents).toBe(292_675n);
    expect(data.categories.map((c) => c.primary)).toEqual([
      'RENT_AND_UTILITIES',
      'FOOD_AND_DRINK',
      'TRANSPORTATION',
    ]);
    expect(data.categories[0]?.spendCents).toBe(210_000n);
  });

  it('rolls detailed categories up into their primary', () => {
    const { data } = spendingByCategory(ctx(), { period: JULY });
    const food = data.categories.find((c) => c.primary === 'FOOD_AND_DRINK');

    expect(food?.spendCents).toBe(51_675n);
    expect(food?.transactionCount).toBe(2);
    expect(food?.detailed.map((d) => d.detailed)).toEqual([
      'FOOD_AND_DRINK_GROCERIES',
      'FOOD_AND_DRINK_RESTAURANT',
    ]);
    expect(food?.detailed.reduce((a, d) => a + d.spendCents, 0n)).toBe(food?.spendCents);
  });

  it('excludes income so the total is spending, not net movement', () => {
    const { data } = spendingByCategory(ctx(), { period: JULY });
    expect(data.categories.map((c) => c.primary)).not.toContain('INCOME');
  });

  it('shares sum to roughly 100% of spend', () => {
    const { data } = spendingByCategory(ctx(), { period: JULY });
    const total = data.categories.reduce((a, c) => a + (c.shareBasisPoints ?? 0), 0);
    // Integer basis-point truncation can lose a few hundredths of a percent.
    expect(total).toBeGreaterThan(9_990);
    expect(total).toBeLessThanOrEqual(10_000);
  });

  it('nets refunds against their category rather than hiding them', () => {
    const snap = snapshot({
      transactions: [
        transaction({ date: '2026-07-02', amount: 200, primary: 'GENERAL_MERCHANDISE' }),
        transaction({ date: '2026-07-09', amount: -50, primary: 'GENERAL_MERCHANDISE' }),
      ],
    });
    const { data } = spendingByCategory(ctx(snap), { period: JULY });

    expect(data.categories[0]?.spendCents).toBe(15_000n);
    expect(data.categories[0]?.transactionCount).toBe(2);
  });

  it('keeps uncategorised spend visible instead of dropping it', () => {
    const snap = snapshot({
      transactions: [transaction({ date: '2026-07-02', amount: 75 })], // no category
    });
    const { data, provenance } = spendingByCategory(ctx(snap), { period: JULY });

    expect(data.uncategorizedCents).toBe(7_500n);
    expect(data.categories[0]?.primary).toBe('UNCATEGORIZED');
    expect(provenance.notes?.join(' ')).toMatch(/without a category/);
  });

  it('returns an empty result for a period with no activity', () => {
    const { data } = spendingByCategory(ctx(), { period: { from: '2026-06-01', to: '2026-06-30' } });
    expect(data.totalSpendCents).toBe(0n);
    expect(data.categories).toEqual([]);
  });
});
