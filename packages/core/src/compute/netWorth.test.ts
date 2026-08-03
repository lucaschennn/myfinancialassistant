import { describe, expect, it } from 'vitest';
import { netWorth } from './netWorth.js';
import { TEST_USER_ID, account, snapshot, typicalSnapshot } from '../testing/fixtures.js';
import { SnapshotOwnershipError } from '../context.js';

const ctx = (snap = typicalSnapshot()) => ({ userId: TEST_USER_ID, snapshot: snap });

describe('netWorth', () => {
  it('subtracts liabilities from assets across all account types', () => {
    const { data } = netWorth(ctx());

    // 4,250.75 + 18,000 + 152,300.40 + 520,000 (house counts here)
    expect(data.assetsCents).toBe(69_455_115n);
    // 2,310.20 card + 310,000 mortgage
    expect(data.liabilitiesCents).toBe(31_231_020n);
    expect(data.netWorthCents).toBe(38_224_095n);
    expect(data.netWorthCents).toBe(data.assetsCents - data.liabilitiesCents);
  });

  it('reports liabilities as negative contributions but positive totals', () => {
    const { data } = netWorth(ctx());
    const card = data.lines.find((l) => l.accountId === 'acct_card');
    const savings = data.lines.find((l) => l.accountId === 'acct_savings');

    expect(card?.contributionCents).toBe(-231_020n);
    expect(savings?.contributionCents).toBe(1_800_000n);
  });

  it('includes illiquid assets — that is what separates it from fireProgress', () => {
    const { data } = netWorth(ctx());
    expect(data.lines.map((l) => l.accountId)).toContain('acct_house');
  });

  it('excludes accounts with no reported balance and says so', () => {
    const snap = snapshot({
      accounts: [
        account({ id: 'acct_a', type: 'depository', current: 100 }),
        account({ id: 'acct_broken', type: 'depository', current: null }),
      ],
    });
    const { data, provenance } = netWorth(ctx(snap));

    expect(data.netWorthCents).toBe(10_000n);
    expect(data.excludedAccountIds).toEqual(['acct_broken']);
    expect(provenance.notes?.join(' ')).toMatch(/no current balance/);
  });

  it('returns zero for a user with no accounts rather than throwing', () => {
    const { data } = netWorth(ctx(snapshot()));
    expect(data.netWorthCents).toBe(0n);
    expect(data.lines).toEqual([]);
  });

  it('surfaces a fetch gap in provenance', () => {
    const snap = snapshot({
      accounts: [account({ type: 'depository', current: 50 })],
      gaps: [
        {
          itemId: 'item_down',
          institutionName: 'Second National',
          dataset: 'balances',
          reason: 'ITEM_LOGIN_REQUIRED',
        },
      ],
    });
    const { provenance } = netWorth(ctx(snap));
    expect(provenance.notes?.join(' ')).toContain('Second National');
  });

  it('carries provenance identifying it as computed, not fetched', () => {
    const { provenance } = netWorth(ctx());
    expect(provenance.source).toBe('compute');
    expect(provenance.asOf).toBe('2026-08-01T12:00:00.000Z');
    expect(provenance.computation).toBeTruthy();
    expect(provenance.inputs).toContain('getBalances');
  });

  it('refuses to compute over another user\'s snapshot', () => {
    const foreign = snapshot({ userId: 'someone-else' });
    expect(() => netWorth({ userId: TEST_USER_ID, snapshot: foreign })).toThrow(
      SnapshotOwnershipError,
    );
  });
});
