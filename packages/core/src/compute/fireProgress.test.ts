import { describe, expect, it } from 'vitest';
import { fireProgress } from './fireProgress.js';
import { netWorth } from './netWorth.js';
import { TEST_USER_ID, account, snapshot, typicalSnapshot } from '../testing/fixtures.js';

const ctx = (snap = typicalSnapshot()) => ({ userId: TEST_USER_ID, snapshot: snap });
const SIXTY_K = 6_000_000n;

describe('fireProgress', () => {
  it('defaults to the 25× rule', async () => {
    const { data } = await fireProgress(ctx(), { annualSpendCents: SIXTY_K });
    expect(data.targetCents).toBe(150_000_000n);
    expect(data.basis).toEqual({ kind: 'multiple', multiple: 25 });
  });

  it('lets withdrawalRate override the multiple', async () => {
    const { data } = await fireProgress(ctx(), {
      annualSpendCents: SIXTY_K,
      multiple: 25,
      withdrawalRate: 0.04,
    });
    // 4% and 25× describe the same target — this is the arithmetic check.
    expect(data.targetCents).toBe(150_000_000n);
    expect(data.basis).toEqual({ kind: 'withdrawal_rate', withdrawalRate: 0.04 });
  });

  it('produces a different target for a rate that is not 1/multiple', async () => {
    const { data } = await fireProgress(ctx(), {
      annualSpendCents: SIXTY_K,
      withdrawalRate: 0.035,
    });
    expect(data.targetCents).toBe(171_428_571n);
  });

  it('excludes illiquid assets from investable net worth', async () => {
    const { data } = await fireProgress(ctx(), { annualSpendCents: SIXTY_K });

    // checking + savings + brokerage — the $520k house is deliberately absent.
    expect(data.investableAssetsCents).toBe(17_455_115n);
    expect(data.investableAccountIds).not.toContain('acct_house');
    expect(data.excludedAccountIds).toContain('acct_house');
  });

  it('does not subtract the mortgage when it excludes the house', async () => {
    const { data } = await fireProgress(ctx(), { annualSpendCents: SIXTY_K });

    // Subtracting a $310k mortgage while ignoring the $520k house behind it
    // would charge for the same property twice — once here, once through the
    // mortgage payment inside the annual spend that sets the target.
    expect(data.excludedLiabilitiesCents).toBe(31_000_000n);
    expect(data.excludedLiabilityAccountIds).toEqual(['acct_mortgage']);

    // The credit card is still subtracted: its payment is not baked into a
    // long-run retirement spending target the way housing is.
    expect(data.liabilitiesCents).toBe(231_020n);
    expect(data.investableNetWorthCents).toBe(17_224_095n);
    expect(data.progressBasisPoints).toBe(1148);
  });

  it('still subtracts auto and student loans', async () => {
    const snap = snapshot({
      accounts: [
        account({ id: 'acct_inv', type: 'investment', current: 100_000 }),
        account({ id: 'acct_car', type: 'loan', subtype: 'auto', current: 15_000 }),
        account({ id: 'acct_edu', type: 'loan', subtype: 'student', current: 25_000 }),
      ],
    });
    const { data } = await fireProgress(ctx(snap), { annualSpendCents: SIXTY_K });

    expect(data.liabilitiesCents).toBe(4_000_000n);
    expect(data.excludedLiabilitiesCents).toBe(0n);
    expect(data.investableNetWorthCents).toBe(6_000_000n);
  });

  it('treats a HELOC as housing debt too', async () => {
    const snap = snapshot({
      accounts: [
        account({ id: 'acct_inv', type: 'investment', current: 100_000 }),
        account({ id: 'acct_heloc', type: 'loan', subtype: 'home equity', current: 40_000 }),
      ],
    });
    const { data } = await fireProgress(ctx(snap), { annualSpendCents: SIXTY_K });

    expect(data.excludedLiabilitiesCents).toBe(4_000_000n);
    expect(data.investableNetWorthCents).toBe(10_000_000n);
  });

  it('subtracts a credit card even if the user calls it a mortgage', async () => {
    // Only `loan`-type accounts can be housing debt — a credit account never is,
    // whatever its subtype says.
    const snap = snapshot({
      accounts: [
        account({ id: 'acct_inv', type: 'investment', current: 100_000 }),
        account({ id: 'acct_card', type: 'credit', subtype: 'mortgage', current: 5_000 }),
      ],
    });
    const { data } = await fireProgress(ctx(snap), { annualSpendCents: SIXTY_K });

    expect(data.liabilitiesCents).toBe(500_000n);
    expect(data.excludedLiabilitiesCents).toBe(0n);
  });

  it('explains that housing debt was left out, and that net worth still counts it', async () => {
    const { provenance } = await fireProgress(ctx(), { annualSpendCents: SIXTY_K });
    const notes = provenance.notes?.join(' ') ?? '';

    expect(notes).toContain('Mortgage');
    expect(notes).toMatch(/does reduce your overall net worth/);
  });

  it('flags that a rental property would be misread as a residence', async () => {
    const { provenance } = await fireProgress(ctx(), { annualSpendCents: SIXTY_K });
    expect(provenance.notes?.join(' ')).toMatch(/rental properties/);
  });

  it('leaves netWorth unchanged — that figure still counts both house and mortgage', async () => {
    const { data } = netWorth(ctx());
    expect(data.netWorthCents).toBe(38_224_095n);
    expect(data.liabilitiesCents).toBe(31_231_020n);
  });

  it('computes a straightforward positive case', async () => {
    const snap = snapshot({
      accounts: [
        account({ id: 'acct_cash', type: 'depository', current: 100_000 }),
        account({ id: 'acct_inv', type: 'investment', current: 650_000 }),
      ],
    });
    const { data } = await fireProgress(ctx(snap), { annualSpendCents: SIXTY_K });

    expect(data.investableNetWorthCents).toBe(75_000_000n);
    expect(data.progressBasisPoints).toBe(5000); // exactly 50%
    expect(data.shortfallCents).toBe(75_000_000n);
  });

  it('reports zero shortfall once the target is met', async () => {
    const snap = snapshot({
      accounts: [account({ id: 'acct_inv', type: 'investment', current: 2_000_000 })],
    });
    const { data } = await fireProgress(ctx(snap), { annualSpendCents: SIXTY_K });

    expect(data.shortfallCents).toBe(0n);
    expect(data.progressBasisPoints).toBeGreaterThan(10_000);
  });

  it('explains which accounts it left out', async () => {
    const { provenance } = await fireProgress(ctx(), { annualSpendCents: SIXTY_K });
    expect(provenance.notes?.join(' ')).toContain('Primary Residence');
    expect(provenance.notes?.join(' ')).toMatch(/still count toward overall net worth/);
  });

  it('rejects a withdrawal rate given as a percent instead of a fraction', async () => {
    await expect(
      fireProgress(ctx(), { annualSpendCents: SIXTY_K, withdrawalRate: 4 }),
    ).rejects.toThrow(/fraction/);
  });

  it('rejects a non-positive spend or multiple', async () => {
    await expect(fireProgress(ctx(), { annualSpendCents: 0n })).rejects.toThrow(RangeError);
    await expect(
      fireProgress(ctx(), { annualSpendCents: SIXTY_K, multiple: 0 }),
    ).rejects.toThrow(RangeError);
  });

  it('explains what to do when no spend target exists anywhere', async () => {
    // No annualSpendCents and no db on ctx — the error has to be actionable.
    await expect(fireProgress(ctx(), {})).rejects.toThrow(/needs a database handle|setProfile/);
  });
});
