import { describe, expect, it } from 'vitest';
import {
  absCents,
  dollarsToCents,
  dollarsToCentsOrNull,
  formatCents,
  ratioToBasisPoints,
  sumCents,
  toJson,
} from './money.js';

describe('dollarsToCents', () => {
  it('converts whole and fractional dollars', () => {
    expect(dollarsToCents(0)).toBe(0n);
    expect(dollarsToCents(1)).toBe(100n);
    expect(dollarsToCents(1234.56)).toBe(123_456n);
  });

  it('handles negative amounts (Plaid inflows)', () => {
    expect(dollarsToCents(-42.5)).toBe(-4250n);
    expect(dollarsToCents(-0.01)).toBe(-1n);
  });

  it('avoids the extra rounding error that multiplying by 100 introduces', () => {
    // 1.115 is stored as 1.11499999999999999, so 111 is the faithful answer.
    // Math.round(1.115 * 100) returns 112, because the multiply drifts upward
    // to 111.50000000000001 and crosses the boundary.
    expect(Math.round(1.115 * 100)).toBe(112);
    expect(dollarsToCents(1.115)).toBe(111n);

    // Same story in the other direction: the multiply drifts down here.
    expect(Math.round(1234.565 * 100)).toBe(123_457);
    expect(dollarsToCents(1234.565)).toBe(123_457n);
  });

  it('cannot recover precision the float literal never had', () => {
    // 4.475 arrives as 4.4749999999999996. No conversion can know the author
    // meant 4.48 — which is why floats are banned everywhere past this boundary.
    expect(dollarsToCents(4.475)).toBe(447n);
    expect(dollarsToCents(1.005)).toBe(100n);
  });

  it('survives values where float multiplication drifts', () => {
    expect(dollarsToCents(0.1 + 0.2)).toBe(30n);
    expect(dollarsToCents(152_300.4)).toBe(15_230_040n);
  });

  it('handles amounts beyond what a float can hold exactly in cents', () => {
    expect(dollarsToCents(999_999_999.99)).toBe(99_999_999_999n);
  });

  it('rejects non-finite input rather than producing a silent NaN', () => {
    expect(() => dollarsToCents(Number.NaN)).toThrow(TypeError);
    expect(() => dollarsToCents(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it('passes null and undefined through', () => {
    expect(dollarsToCentsOrNull(null)).toBeNull();
    expect(dollarsToCentsOrNull(undefined)).toBeNull();
    expect(dollarsToCentsOrNull(12.34)).toBe(1234n);
  });
});

describe('sumCents / absCents', () => {
  it('sums exactly, with no accumulated drift', () => {
    const pennies = Array.from({ length: 10_000 }, () => 1n);
    expect(sumCents(pennies)).toBe(10_000n);
  });

  it('takes magnitudes', () => {
    expect(absCents(-500n)).toBe(500n);
    expect(absCents(500n)).toBe(500n);
  });
});

describe('ratioToBasisPoints', () => {
  it('expresses a ratio in basis points', () => {
    expect(ratioToBasisPoints(2500n, 10_000n)).toBe(2500);
    expect(ratioToBasisPoints(10_000n, 10_000n)).toBe(10_000);
  });

  it('returns null for a zero or negative denominator instead of Infinity', () => {
    expect(ratioToBasisPoints(100n, 0n)).toBeNull();
    expect(ratioToBasisPoints(100n, -50n)).toBeNull();
  });

  it('allows negative ratios — overspending is a real result', () => {
    expect(ratioToBasisPoints(-2000n, 10_000n)).toBe(-2000);
  });
});

describe('formatCents', () => {
  it('renders currency with grouping', () => {
    expect(formatCents(123_456_789n)).toBe('$1,234,567.89');
    expect(formatCents(-4250n)).toBe('-$42.50');
    expect(formatCents(5n)).toBe('$0.05');
    expect(formatCents(0n)).toBe('$0.00');
  });
});

describe('toJson', () => {
  it('serialises bigint as a decimal string so evidence bundles survive JSON', () => {
    expect(toJson({ netWorthCents: 123n })).toBe('{"netWorthCents":"123"}');
  });

  it('throws without the replacer, which is why it exists', () => {
    expect(() => JSON.stringify({ a: 1n })).toThrow(TypeError);
  });
});
