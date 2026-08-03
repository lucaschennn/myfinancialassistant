import { type Ctx, requireSnapshot } from '../context.js';
import { type Cents, ZERO } from '../money.js';
import { type Provenance, type ToolResult, result } from '../provenance.js';
import { gapNotes } from '../snapshot.js';
import { type Period, type SelectOptions, assertPeriod, selectTransactions } from './period.js';

export interface CashFlowData {
  inflowCents: Cents;
  outflowCents: Cents;
  /** inflow − outflow. Negative means more went out than came in. */
  netCents: Cents;
  transactionCount: number;
  period: Period;
}

export interface CashFlowParams extends SelectOptions {
  period: Period;
}

/**
 * cashFlow (§4): inflow and outflow over an explicit date range.
 *
 * Plaid's sign convention is the trap here: a POSITIVE amount means money left
 * the account. That is inverted exactly once, at this boundary, and both sides
 * are reported as positive magnitudes so downstream consumers never have to
 * reason about it again.
 */
export function cashFlow(ctx: Ctx, params: CashFlowParams): ToolResult<CashFlowData> {
  const snapshot = requireSnapshot(ctx, 'cashFlow');
  const { period, ...selectOptions } = params;
  assertPeriod(period, 'cashFlow');

  const selection = selectTransactions(snapshot, period, selectOptions);

  let inflowCents = ZERO;
  let outflowCents = ZERO;
  for (const t of selection.transactions) {
    if (t.amountCents > ZERO) {
      outflowCents += t.amountCents;
    } else {
      inflowCents += -t.amountCents;
    }
  }

  const notes = [...gapNotes(snapshot, 'transactions'), ...selection.notes];

  const provenance: Provenance = {
    source: 'compute',
    asOf: snapshot.fetchedAt,
    accountIds: selection.accountIds,
    period,
    computation:
      'Money arriving and money leaving, summed separately over the period. Plaid reports ' +
      'outflows as positive amounts; both sides are reported here as positive magnitudes.',
    inputs: ['getTransactions'],
    ...(notes.length > 0 ? { notes } : {}),
  };

  return result(
    {
      inflowCents,
      outflowCents,
      netCents: inflowCents - outflowCents,
      transactionCount: selection.transactions.length,
      period,
    },
    provenance,
  );
}
