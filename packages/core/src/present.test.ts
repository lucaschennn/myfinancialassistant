import { describe, expect, it } from 'vitest';
import { humanize } from './present.js';

describe('humanize', () => {
  it('adds a formatted sibling for every cents field', () => {
    expect(humanize({ netWorthCents: 38_224_095n })).toEqual({
      netWorthCents: 38_224_095n,
      netWorth: '$382,240.95',
    });
  });

  it('adds a percent sibling for every basis-points field', () => {
    expect(humanize({ shareBasisPoints: 5909 })).toEqual({
      shareBasisPoints: 5909,
      share: '59.09%',
    });
  });

  it('recurses through arrays and nested objects', () => {
    const out = humanize({
      buckets: [{ assetClass: 'equity', valueCents: 4_000_000n }],
    }) as { buckets: Array<{ value: string }> };

    expect(out.buckets[0]?.value).toBe('$40,000.00');
  });

  it('leaves null cents and null rates alone rather than printing "$NaN"', () => {
    expect(humanize({ currentCents: null, savingsRateBasisPoints: null })).toEqual({
      currentCents: null,
      savingsRateBasisPoints: null,
    });
  });

  it('formats negatives, which are real answers here', () => {
    const out = humanize({
      investableNetWorthCents: -13_775_905n,
      progressBasisPoints: -918,
    }) as Record<string, unknown>;

    expect(out.investableNetWorth).toBe('-$137,759.05');
    expect(out.progress).toBe('-9.18%');
  });

  it('does not mutate its input', () => {
    const input = { netWorthCents: 100n };
    humanize(input);
    expect(Object.keys(input)).toEqual(['netWorthCents']);
  });
});
