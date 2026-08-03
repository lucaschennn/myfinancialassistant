import type { Ctx } from '../context.js';
import { summaryOverview } from './summaryOverview.js';
import type { Workflow, WorkflowName, WorkflowParams, WorkflowRun } from './types.js';

/**
 * The workflow registry (§5). Phase 0 implements `summary_overview` only; the
 * remaining intents land in Phase 1. Registering them as they are built keeps
 * the router honest — it can only route to something that exists.
 */
const WORKFLOWS: Partial<Record<WorkflowName, Workflow>> = {
  summary_overview: summaryOverview,
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

export { summaryOverview };
export type { Workflow, WorkflowName, WorkflowParams, WorkflowRun } from './types.js';
