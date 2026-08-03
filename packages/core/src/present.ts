/**
 * Presentation pass over tool output.
 *
 * Purpose is narrower than it looks: if the model is handed `netWorthCents:
 * 38224095n` and nothing else, the tempting next step is to divide by 100
 * itself — which is the model computing a figure (§0.1). So every `…Cents`
 * field gains a pre-formatted sibling, and every `…BasisPoints` field gains a
 * percent string. The model then has nothing left to calculate.
 *
 * Display strings are output only. Nothing reads them back in.
 */

import { type Cents, basisPointsToPercent, formatCents } from './money.js';

const CENTS_SUFFIX = 'Cents';
const BPS_SUFFIX = 'BasisPoints';

function stripSuffix(key: string, suffix: string): string {
  return key.slice(0, -suffix.length);
}

function formatPercent(bps: number): string {
  const percent = basisPointsToPercent(bps);
  return `${percent.toFixed(2)}%`;
}

/**
 * Recursively annotate a value with human-readable siblings. Returns a new
 * structure; the input is never mutated.
 */
export function humanize<T>(value: T): unknown {
  if (Array.isArray(value)) return value.map(humanize);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    out[key] = humanize(raw);

    if (key.endsWith(CENTS_SUFFIX) && typeof raw === 'bigint') {
      out[stripSuffix(key, CENTS_SUFFIX)] = formatCents(raw as Cents);
    } else if (key.endsWith(BPS_SUFFIX) && typeof raw === 'number') {
      out[stripSuffix(key, BPS_SUFFIX)] = formatPercent(raw);
    }
  }
  return out;
}
