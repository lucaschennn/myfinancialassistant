/**
 * The §0.1 guard, made testable.
 *
 * "The AI never computes a number" is the spec's first principle, and until now
 * it held for a structural reason: no model was in the loop, so there was
 * nothing that *could* compute. Synthesis changes that. From here the invariant
 * rests on a prompt — and a prompt is a request, not a guarantee.
 *
 * So this checks it instead. Every currency figure and percentage in the
 * model's prose must correspond to one the evidence bundle already produced,
 * pre-formatted by `humanize()` (§ present.ts). A figure that appears in the
 * narration but not in the bundle is either a hallucination or arithmetic the
 * model did itself. Both are bugs, and both are §0.1 violations.
 *
 * This is a detector, not a sanitiser. It reports; the caller decides.
 */

import { formatCents } from '../money.js';
import { humanize } from '../present.js';
import type { EvidenceBundle } from '../provenance.js';

/**
 * Currency as `humanize()` writes it, and as a model would naturally quote it:
 * an optional minus, `$`, digits with optional thousands separators, and
 * optional cents.
 */
const CURRENCY = /-?\$\s?\d[\d,]*(?:\.\d+)?/g;

/** Percentages: `12%`, `12.5 %`, `-3.25%`. */
const PERCENT = /-?\d[\d,]*(?:\.\d+)?\s?%/g;

export interface AttributionViolation {
  /** The figure exactly as the model wrote it. */
  figure: string;
  kind: 'currency' | 'percent';
  /** Where it appeared, for a useful error message. */
  context: string;
}

export interface AttributionReport {
  ok: boolean;
  violations: AttributionViolation[];
  /** Every figure the bundle authorised. Useful when debugging a failure. */
  allowed: string[];
}

function parseCurrencyToCents(raw: string): bigint | null {
  const cleaned = raw.replace(/[\s$,]/g, '');
  const negative = cleaned.startsWith('-');
  const digits = negative ? cleaned.slice(1) : cleaned;
  const [whole, frac = ''] = digits.split('.');
  if (whole === undefined || whole === '' || !/^\d+$/.test(whole)) return null;
  if (frac && !/^\d+$/.test(frac)) return null;

  const cents = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  return negative ? -cents : cents;
}

function parsePercent(raw: string): number | null {
  const value = Number(raw.replace(/[\s%,]/g, ''));
  return Number.isFinite(value) ? value : null;
}

/**
 * Collect every display string the bundle authorises.
 *
 * `humanize()` already attaches a formatted sibling to every `…Cents` and
 * `…BasisPoints` field, so walking the humanised bundle finds exactly the
 * figures the model was given — no more, no less. That is the whole point of
 * the presentation pass: the model is never handed a raw integer it would have
 * to divide by 100 itself.
 */
export function allowedFigures(bundle: EvidenceBundle): {
  currencyCents: Set<string>;
  percents: Set<number>;
  display: string[];
} {
  const currencyCents = new Set<string>();
  const percents = new Set<number>();
  const display: string[] = [];

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== 'object') {
      if (typeof value !== 'string') return;

      for (const match of value.match(CURRENCY) ?? []) {
        const cents = parseCurrencyToCents(match);
        if (cents !== null) {
          currencyCents.add(cents.toString());
          display.push(match);
        }
      }
      for (const match of value.match(PERCENT) ?? []) {
        const percent = parsePercent(match);
        if (percent !== null) {
          percents.add(percent);
          display.push(match);
        }
      }
      return;
    }
    Object.values(value as Record<string, unknown>).forEach(visit);
  };

  visit(humanize(bundle));

  // Zero is always sayable: "you have no credit card debt" needs no evidence
  // entry, and refusing it would push the model toward vaguer language.
  currencyCents.add('0');
  percents.add(0);

  return { currencyCents, percents, display };
}

/**
 * Whether a figure the model wrote is one the bundle authorised.
 *
 * Rounding is allowed deliberately. A coach that has to say "-$40,452.32" every
 * time reads like a receipt, and "about $40,452" is the same figure at lower
 * precision — not a new one. What stays forbidden is a value the bundle never
 * produced. So a written figure matches if it equals an allowed value exactly,
 * or if some allowed value rounds or truncates to it at whole-dollar,
 * hundred, or thousand granularity.
 */
function currencyIsAuthorised(writtenCents: bigint, allowed: Set<string>): boolean {
  if (allowed.has(writtenCents.toString())) return true;

  for (const raw of allowed) {
    const actual = BigInt(raw);
    for (const unit of [100n, 10_000n, 100_000n]) {
      const half = unit / 2n;
      const rounded = ((actual < 0n ? actual - half : actual + half) / unit) * unit;
      const truncated = (actual / unit) * unit;
      if (writtenCents === rounded || writtenCents === truncated) return true;
    }
  }
  return false;
}

function percentIsAuthorised(written: number, allowed: Set<number>): boolean {
  for (const actual of allowed) {
    // Match at whole-percent and one-decimal precision.
    if (Math.abs(actual - written) < 1e-9) return true;
    if (Math.round(actual) === written) return true;
    if (Math.abs(Math.round(actual * 10) / 10 - written) < 1e-9) return true;
    if (Math.trunc(actual) === written) return true;
  }
  return false;
}

function contextAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${
    end < text.length ? '…' : ''
  }`;
}

/**
 * Check a synthesis response against the bundle that produced it.
 *
 * Called on every agent turn, not just in tests — a violation in production is
 * exactly the case worth catching, and it is the only place §0.1 can actually
 * be enforced rather than requested.
 */
export function checkAttribution(text: string, bundle: EvidenceBundle): AttributionReport {
  const { currencyCents, percents, display } = allowedFigures(bundle);
  const violations: AttributionViolation[] = [];

  for (const match of text.matchAll(CURRENCY)) {
    const written = parseCurrencyToCents(match[0]);
    if (written === null) continue;
    if (!currencyIsAuthorised(written, currencyCents)) {
      violations.push({
        figure: match[0],
        kind: 'currency',
        context: contextAround(text, match.index ?? 0, match[0].length),
      });
    }
  }

  for (const match of text.matchAll(PERCENT)) {
    const written = parsePercent(match[0]);
    if (written === null) continue;
    if (!percentIsAuthorised(written, percents)) {
      violations.push({
        figure: match[0],
        kind: 'percent',
        context: contextAround(text, match.index ?? 0, match[0].length),
      });
    }
  }

  return { ok: violations.length === 0, violations, allowed: display };
}

/** A message for the user when the guard fires — honest, not alarming (§6). */
export function attributionFailureMessage(report: AttributionReport): string {
  const figures = report.violations.map((v) => v.figure).join(', ');
  return (
    'I generated an answer that included figures I could not trace back to your ' +
    `accounts (${figures}), so I have held it back rather than show you numbers I ` +
    'cannot stand behind. The summary and evidence below come straight from the ' +
    'tools and are unaffected. Please ask again.'
  );
}

/** Exposed for tests and for the "why" card's figure list. */
export { formatCents };
