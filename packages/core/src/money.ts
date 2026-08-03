/**
 * Money is integer cents, always, represented as `bigint` (§0.3). No floats
 * ever touch a stored or computed figure. Floats appear in exactly one place:
 * the boundary where Plaid hands us dollars as a JS number, and
 * `dollarsToCents` is the only function allowed to cross it.
 */

export type Cents = bigint;

export const ZERO: Cents = 0n;

/**
 * Convert Plaid's dollar amount (a JS float) into integer cents.
 *
 * We route through `toFixed(2)` rather than `Math.round(d * 100)` because
 * multiplying by 100 introduces a SECOND rounding error on top of the one
 * already baked into the literal, and it can flip a value across the half-cent
 * boundary. `1.115` is stored as 1.11499999999999999, so 111 is the faithful
 * answer — but `1.115 * 100` evaluates to 111.50000000000001, and
 * `Math.round` returns 112. `toFixed(2)` rounds the stored value's own decimal
 * expansion and returns 1.11.
 *
 * Neither approach can recover precision the literal never had: 4.475 arrives
 * as 4.4749999999999996 and converts to 447, not 448. That is a limit of
 * taking money as a float at all, which is exactly why this is the only
 * function permitted to do so.
 */
export function dollarsToCents(dollars: number): Cents {
  if (!Number.isFinite(dollars)) {
    throw new TypeError(`dollarsToCents: expected a finite number, got ${dollars}`);
  }
  const fixed = dollars.toFixed(2);
  const negative = fixed.startsWith('-');
  const [whole = '0', frac = '00'] = (negative ? fixed.slice(1) : fixed).split('.');
  const magnitude = BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'));
  return negative ? -magnitude : magnitude;
}

/** Nullable passthrough for Plaid fields that are legitimately absent. */
export function dollarsToCentsOrNull(dollars: number | null | undefined): Cents | null {
  return dollars === null || dollars === undefined ? null : dollarsToCents(dollars);
}

export function sumCents(values: Iterable<Cents>): Cents {
  let total = ZERO;
  for (const v of values) total += v;
  return total;
}

export function absCents(value: Cents): Cents {
  return value < ZERO ? -value : value;
}

/**
 * Percentage as basis points (1/100th of a percent), integer — the same
 * no-floats discipline applied to ratios. 2500 bps = 25.00%.
 *
 * Returns null for a zero or negative denominator rather than Infinity/NaN, so
 * callers must decide what an undefined ratio means in their context instead of
 * silently rendering "NaN%" to a user.
 */
export function ratioToBasisPoints(numerator: Cents, denominator: Cents): number | null {
  if (denominator <= ZERO) return null;
  // Scale before dividing so the integer division keeps 4 significant places.
  return Number((numerator * 10_000n) / denominator);
}

export function basisPointsToPercent(bps: number): number {
  return bps / 100;
}

/** Display helper. Presentation only — never feed this back into a computation. */
export function formatCents(cents: Cents, currency = 'USD'): string {
  const negative = cents < ZERO;
  const magnitude = negative ? -cents : cents;
  const whole = magnitude / 100n;
  const frac = magnitude % 100n;
  const formattedWhole = whole.toLocaleString('en-US');
  const sign = negative ? '-' : '';
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return `${sign}${symbol}${formattedWhole}.${frac.toString().padStart(2, '0')}`;
}

/**
 * `JSON.stringify` throws on bigint. Evidence bundles get serialised into model
 * prompts and API responses, so every bigint is emitted as a decimal string.
 * Use as `JSON.stringify(value, jsonReplacer)`.
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function toJson(value: unknown, space?: number): string {
  return JSON.stringify(value, jsonReplacer, space);
}
