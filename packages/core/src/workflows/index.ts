import type { Ctx } from '../context.js';
import { generalQa } from './generalQa.js';
import { goalProgress } from './goalProgress.js';
import { investmentReview } from './investmentReview.js';
import { spendingAnalysis } from './spendingAnalysis.js';
import { summaryOverview } from './summaryOverview.js';
import { transactionLookup } from './transactionLookup.js';
import type { Workflow, WorkflowName, WorkflowParams, WorkflowRun } from './types.js';

/**
 * The workflow registry (§5). All six intents are implemented as of Phase 1 —
 * the router can now route to any of them and reach a real pipeline rather
 * than degrading to the summary.
 */
const WORKFLOWS: Record<WorkflowName, Workflow> = {
  summary_overview: summaryOverview,
  spending_analysis: spendingAnalysis,
  investment_review: investmentReview,
  goal_progress: goalProgress,
  transaction_lookup: transactionLookup,
  general_qa: generalQa,
};

export class UnknownWorkflowError extends Error {
  constructor(name: string) {
    super(
      `No workflow registered for "${name}". Implemented: ${Object.keys(WORKFLOWS).join(', ')}.`,
    );
    this.name = 'UnknownWorkflowError';
  }
}

export async function runWorkflow(
  name: WorkflowName,
  ctx: Ctx,
  params: WorkflowParams = {},
): Promise<WorkflowRun> {
  const workflow = WORKFLOWS[name];
  if (!workflow) throw new UnknownWorkflowError(name);
  return workflow(ctx, params);
}

export function implementedWorkflows(): WorkflowName[] {
  return Object.keys(WORKFLOWS) as WorkflowName[];
}

export {
  summaryOverview,
  spendingAnalysis,
  investmentReview,
  goalProgress,
  transactionLookup,
  generalQa,
};
export type { Limitation, Workflow, WorkflowName, WorkflowParams, WorkflowRun } from './types.js';
