/**
 * `investment_review` (§5): getHoldings → assetAllocation.
 *
 * The shortest pipeline in the spec, and the one most dependent on its
 * provenance notes: `assetAllocation` buckets ETFs and mutual funds as `other`
 * because fund lookthrough is unavailable, which understates true equity
 * exposure for a fund-heavy portfolio. That caveat travels with the figure
 * rather than being lost between the tool and the narration.
 */

import { EvidenceBuilder } from '../provenance.js';
import { assetAllocation } from '../compute/assetAllocation.js';
import { getHoldings } from '../tools/aggregation.js';
import type { Ctx } from '../context.js';
import type { Limitation, WorkflowParams, WorkflowRun } from './types.js';

export async function investmentReview(
  ctx: Ctx,
  params: WorkflowParams = {},
): Promise<WorkflowRun> {
  const evidence = new EvidenceBuilder('investment_review', ctx.userId);
  const limitations: Limitation[] = [];

  const scope = params.accountIds ? { accountIds: params.accountIds } : {};

  const holdings = evidence.add('getHoldings', scope, getHoldings(ctx, scope));
  evidence.add('assetAllocation', scope, assetAllocation(ctx, scope));

  // Distinguish "no investment accounts linked" from "we failed" — the first is
  // a fact about the user, and saying it plainly beats an empty allocation
  // table the model has to explain away (§6).
  if (holdings.holdings.length === 0) {
    limitations.push({
      tool: 'getHoldings',
      reason:
        'No investment holdings were returned. Either no investment accounts are connected, ' +
        'or the institution did not provide holdings data.',
    });
  }

  return { bundle: evidence.build(), limitations };
}
