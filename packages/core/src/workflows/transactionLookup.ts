/**
 * `transaction_lookup` (§5): getTransactions, filtered.
 *
 * A single tool, and deliberately so. This workflow answers "did I pay X" —
 * the model reads a list and reports what is in it. There is no derived figure
 * here at all, which makes it the one place where §0.1 is trivially satisfied:
 * there is nothing to compute.
 *
 * The one thing worth being careful about is scope. A lookup that quietly
 * searched only the fetched window would let "no, you never paid that" mean
 * "not in the last 90 days" — so the window is always stated.
 */

import { EvidenceBuilder } from '../provenance.js';
import { getTransactions } from '../tools/aggregation.js';
import { defaultPeriod } from './shared.js';
import type { Ctx } from '../context.js';
import type { Limitation, WorkflowParams, WorkflowRun } from './types.js';

export async function transactionLookup(
  ctx: Ctx,
  params: WorkflowParams = {},
): Promise<WorkflowRun> {
  const evidence = new EvidenceBuilder('transaction_lookup', ctx.userId);
  const limitations: Limitation[] = [];

  const period = params.period ?? defaultPeriod(ctx, 'transaction_lookup');

  const lookupParams = {
    from: period.from,
    to: period.to,
    ...(params.accountIds ? { accountIds: params.accountIds } : {}),
    ...(params.categories ? { categories: params.categories } : {}),
    // A lookup is about finding a specific payment, so the defaults that make
    // sense for cash flow work against it here: a transfer is still a
    // transaction the person made, and a pending charge is often exactly the
    // one they are asking about.
    excludeTransfers: false,
    includePending: true,
  };

  const result = evidence.add('getTransactions', lookupParams, getTransactions(ctx, lookupParams));

  if (result.count === 0) {
    limitations.push({
      tool: 'getTransactions',
      reason:
        `No transactions matched between ${period.from} and ${period.to}. This only covers ` +
        'the transactions fetched for this session — an older one would not appear.',
    });
  }

  return { bundle: evidence.build(), limitations };
}
