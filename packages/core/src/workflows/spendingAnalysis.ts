/**
 * `spending_analysis` (§5): getTransactions → spendingByCategory → cashFlow →
 * savingsRate.
 *
 * Fixed order, like every workflow. Note that `savingsRate` can legitimately
 * fail where the others succeed — it needs income, and a 90-day window with no
 * deposits in it has none. That degrades to a limitation rather than failing
 * the turn, exactly as `fireProgress` does in the summary.
 */

import { EvidenceBuilder } from '../provenance.js';
import { cashFlow } from '../compute/cashFlow.js';
import { savingsRate } from '../compute/savingsRate.js';
import { spendingByCategory } from '../compute/spendingByCategory.js';
import { getTransactions } from '../tools/aggregation.js';
import { defaultPeriod, limitationFrom } from './shared.js';
import type { Ctx } from '../context.js';
import type { Limitation, WorkflowParams, WorkflowRun } from './types.js';

export async function spendingAnalysis(
  ctx: Ctx,
  params: WorkflowParams = {},
): Promise<WorkflowRun> {
  const evidence = new EvidenceBuilder('spending_analysis', ctx.userId);
  const limitations: Limitation[] = [];

  const period = params.period ?? defaultPeriod(ctx, 'spending_analysis');
  const scope = {
    ...(params.accountIds ? { accountIds: params.accountIds } : {}),
  };

  evidence.add(
    'getTransactions',
    { from: period.from, to: period.to, ...scope, ...(params.categories ? { categories: params.categories } : {}) },
    getTransactions(ctx, {
      from: period.from,
      to: period.to,
      ...scope,
      ...(params.categories ? { categories: params.categories } : {}),
    }),
  );

  evidence.add(
    'spendingByCategory',
    { period, ...scope },
    spendingByCategory(ctx, { period, ...scope }),
  );

  evidence.add('cashFlow', { period, ...scope }, cashFlow(ctx, { period, ...scope }));

  // Savings rate needs income in the window to divide by. No income is a real
  // answer ("we can't work this out yet"), not an error.
  try {
    evidence.add('savingsRate', { period, ...scope }, savingsRate(ctx, { period, ...scope }));
  } catch (error) {
    limitations.push(
      limitationFrom(
        'savingsRate',
        'Your savings rate could not be worked out for this period. The spending and ' +
          'cash flow figures above are unaffected.',
        error,
      ),
    );
  }

  return { bundle: evidence.build(), limitations };
}
