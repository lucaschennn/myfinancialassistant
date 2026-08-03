import type { Ctx } from '../context.js';
import { type Cents, ratioToBasisPoints } from '../money.js';
import { type Provenance, type ToolResult, result } from '../provenance.js';
import { cashFlow } from './cashFlow.js';
import type { Period, SelectOptions } from './period.js';

export interface SavingsRateData {
  incomeCents: Cents;
  spendCents: Cents;
  savedCents: Cents;
  /** (income − spend) ÷ income, in basis points. Null when income is zero. */
  savingsRateBasisPoints: number | null;
  period: Period;
}

export interface SavingsRateParams extends SelectOptions {
  period: Period;
}

/**
 * savingsRate (§4): (income − spend) ÷ income over an explicit period.
 *
 * Income and spend are taken from `cashFlow` rather than recomputed, so the two
 * figures can never disagree — a user who asks for both in one conversation
 * gets numbers that reconcile.
 *
 * The rate can be negative (spent more than earned) and is deliberately not
 * clamped to zero: that is a real and important thing for someone to see.
 */
export function savingsRate(ctx: Ctx, params: SavingsRateParams): ToolResult<SavingsRateData> {
  const { period } = params;
  const flow = cashFlow(ctx, params);
  const { inflowCents: incomeCents, outflowCents: spendCents } = flow.data;
  const savedCents = incomeCents - spendCents;

  const notes = [...(flow.provenance.notes ?? [])];
  if (incomeCents === 0n) {
    notes.push(
      'No income was recorded in this period, so a savings rate cannot be calculated. ' +
        'This often means the paycheck lands in an account that is not linked.',
    );
  }

  const provenance: Provenance = {
    source: 'compute',
    asOf: flow.provenance.asOf,
    accountIds: flow.provenance.accountIds ?? [],
    period,
    computation:
      '(money in − money out) ÷ money in, over the period, using the same inflow and outflow ' +
      'figures as the cash flow calculation.',
    inputs: ['cashFlow'],
    ...(notes.length > 0 ? { notes } : {}),
  };

  return result(
    {
      incomeCents,
      spendCents,
      savedCents,
      savingsRateBasisPoints: ratioToBasisPoints(savedCents, incomeCents),
      period,
    },
    provenance,
  );
}
