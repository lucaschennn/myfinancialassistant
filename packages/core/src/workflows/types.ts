import type { Ctx } from '../context.js';
import type { EvidenceBundle } from '../provenance.js';

/**
 * The fixed set of intents (§5). The router's job is to pick one of these; it
 * cannot invent a pipeline. That constraint is what makes the system's
 * processing predictable and auditable (§0.6).
 */
export type WorkflowName =
  | 'summary_overview'
  | 'spending_analysis'
  | 'investment_review'
  | 'goal_progress'
  | 'transaction_lookup'
  | 'general_qa';

export interface WorkflowParams {
  /** Explicit date range, already resolved from the user's words by the router. */
  period?: { from: string; to: string };
  accountIds?: string[];
  categories?: string[];
  /** FIRE knobs, when the user names them. */
  annualSpendCents?: bigint;
  multiple?: number;
  withdrawalRate?: number;
}

export interface WorkflowRun {
  bundle: EvidenceBundle;
  /**
   * Things the pipeline could not do — a step that failed on missing context
   * rather than a bug. Surfaced to the model so it can say so honestly (§6).
   */
  limitations: string[];
}

export type Workflow = (ctx: Ctx, params: WorkflowParams) => Promise<WorkflowRun>;
