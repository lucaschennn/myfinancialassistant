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

/**
 * Something the pipeline could not do — a step that failed on missing context
 * rather than a bug. Surfaced to the model so it can say so honestly (§6), and
 * rendered on the "why" card (§5).
 *
 * Structured rather than a bare string because both consumers need to know
 * *which* step is missing, not just that something is. A card that can only say
 * "not available" has no subject, and the model cannot attribute a gap it
 * cannot name.
 *
 * `reason` is written for the person reading it. Internal error text —
 * "Pass `annualSpendCents` via setProfile" — belongs in the server log, not on
 * a user's screen.
 */
export interface Limitation {
  /**
   * The pipeline step that could not run. Omitted when the gap is about the
   * answer as a whole rather than one tool.
   */
  tool?: string;
  /** Plain-language explanation of what is missing and what would fix it. */
  reason: string;
}

export interface WorkflowRun {
  bundle: EvidenceBundle;
  limitations: Limitation[];
}

export type Workflow = (ctx: Ctx, params: WorkflowParams) => Promise<WorkflowRun>;
