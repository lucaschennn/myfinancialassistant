/**
 * `general_qa` (§5): "constrained fallback; may call a bounded subset, else
 * answers from prior evidence only".
 *
 * This is where someone asks "what is a Roth IRA?" — a question that needs no
 * figures at all. The temptation is to run nothing and let the model answer
 * from its own knowledge, but that quietly removes the grounding every other
 * path has. So it runs the cheapest possible bounded subset: what accounts
 * exist, and what the person's own stated context is.
 *
 * The effect is that even a definitional answer can be related back to the
 * person's actual situation, and the attribution guard still has a bundle to
 * check against — a general question is not a licence to state figures.
 *
 * Notably absent: no transactions, no holdings, no derived compute. The bound
 * is what makes this a constrained fallback rather than an escape hatch.
 */

import { EvidenceBuilder } from '../provenance.js';
import { listAccounts } from '../tools/aggregation.js';
import { getUserContext } from '../tools/userContext.js';
import type { Ctx } from '../context.js';
import type { Limitation, WorkflowParams, WorkflowRun } from './types.js';

export async function generalQa(ctx: Ctx, _params: WorkflowParams = {}): Promise<WorkflowRun> {
  const evidence = new EvidenceBuilder('general_qa', ctx.userId);
  const limitations: Limitation[] = [];

  // Both steps are optional: a conceptual question is still answerable without
  // a Plaid snapshot or a profile, and failing the turn over missing context
  // would be worse than answering generally.
  if (ctx.snapshot) {
    evidence.add('listAccounts', {}, listAccounts(ctx));
  } else {
    limitations.push({
      tool: 'listAccounts',
      reason:
        'No account data was loaded for this question, so the answer is general rather ' +
        'than specific to your situation.',
    });
  }

  if (ctx.db) {
    try {
      evidence.add('getUserContext', {}, await getUserContext(ctx));
    } catch {
      // Profile is a nicety here, not a requirement. Stay quiet.
    }
  }

  return { bundle: evidence.build(), limitations };
}
