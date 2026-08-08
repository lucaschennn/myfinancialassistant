/**
 * `summary_overview` (§5): listAccounts → getBalances → netWorth →
 * assetAllocation → fireProgress.
 *
 * The pipeline is fixed. The model does not choose which tools run or in what
 * order — it only narrates what this produced. That is the property that makes
 * "the AI never computes a number" (§0.1) enforceable rather than aspirational.
 */

import { EvidenceBuilder } from '../provenance.js';
import { assetAllocation } from '../compute/assetAllocation.js';
import { fireProgress } from '../compute/fireProgress.js';
import { netWorth } from '../compute/netWorth.js';
import { getBalances, listAccounts } from '../tools/aggregation.js';
import { appendNetWorthSnapshot } from '../tools/aggregates.js';
import { NO_SPEND_TARGET, limitationFrom } from './shared.js';
import type { Ctx } from '../context.js';
import type { Limitation, WorkflowParams, WorkflowRun } from './types.js';

export async function summaryOverview(ctx: Ctx, params: WorkflowParams = {}): Promise<WorkflowRun> {
  const evidence = new EvidenceBuilder('summary_overview', ctx.userId);
  const limitations: Limitation[] = [];

  const accountParams = params.accountIds ? { accountIds: params.accountIds } : {};

  evidence.add('listAccounts', {}, listAccounts(ctx));
  evidence.add('getBalances', accountParams, getBalances(ctx, accountParams));

  const netWorthResult = netWorth(ctx);
  const netWorthData = evidence.add('netWorth', {}, netWorthResult);

  evidence.add('assetAllocation', accountParams, assetAllocation(ctx, accountParams));

  // fireProgress is the one step with a hard prerequisite: an annual spend
  // target. A user who has not set one should still get the rest of their
  // summary, with the omission stated rather than the request failing.
  const fireParams = {
    ...(params.annualSpendCents !== undefined ? { annualSpendCents: params.annualSpendCents } : {}),
    ...(params.multiple !== undefined ? { multiple: params.multiple } : {}),
    ...(params.withdrawalRate !== undefined ? { withdrawalRate: params.withdrawalRate } : {}),
  };
  try {
    evidence.add('fireProgress', fireParams, await fireProgress(ctx, fireParams));
  } catch (error) {
    limitations.push(limitationFrom('fireProgress', NO_SPEND_TARGET, error));
  }

  // The only write in the pipeline, and it is a derived aggregate (§3 Tier 1).
  // A failure here must not cost the user their answer.
  if (ctx.db) {
    try {
      // Traced because it is the one thing in this pipeline that WRITES. A user
      // reading what a page cost should see that a derived aggregate was
      // persisted, not just that data was read (§0.2, §3 Tier 1).
      await (ctx.trace
        ? ctx.trace.track('db', 'append net worth snapshot', () =>
            appendNetWorthSnapshot(ctx, netWorthData),
          )
        : appendNetWorthSnapshot(ctx, netWorthData));
    } catch (error) {
      limitations.push(
        limitationFrom(
          'appendNetWorthSnapshot',
          "Today's net worth was not saved to your history, so this point may be missing " +
            'from the trend later. The figures above are unaffected.',
          error,
        ),
      );
    }
  }

  return { bundle: evidence.build(), limitations };
}
