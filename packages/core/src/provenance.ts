/**
 * Provenance (§0.2): every figure the system produces carries a record of where
 * it came from. This is structural, not a prompt instruction — a tool result is
 * literally unable to exist without one, because `ToolResult` requires it.
 */

export type ProvenanceSource =
  /** Fetched live from Plaid into the request-scoped snapshot. */
  | 'plaid'
  /** Read from Postgres — user context, goals, derived aggregates. */
  | 'db'
  /** Derived by a deterministic compute function from other tool results. */
  | 'compute'
  /** Supplied by the user (profile targets, notes) rather than measured. */
  | 'user';

export interface Provenance {
  source: ProvenanceSource;
  /** ISO 8601. For `plaid`, when the snapshot was fetched — not "now". */
  asOf: string;
  /** Plaid account ids the figure was computed over. Omitted when not account-scoped. */
  accountIds?: string[];
  /** Plain-language description of the math applied. Rendered in "why" cards. */
  computation?: string;
  /** Names of upstream tool results this derives from, for the evidence chain. */
  inputs?: string[];
  /** Date range the figure covers, for period-scoped computations. */
  period?: { from: string; to: string };
  /**
   * Honest-about-gaps (§6): anything that makes the figure less complete than it
   * looks — an institution that returned no holdings, accounts excluded by
   * definition, pending transactions counted. Surfaced to the user, not hidden.
   */
  notes?: string[];
}

export interface ToolResult<T> {
  data: T;
  provenance: Provenance;
}

export function result<T>(data: T, provenance: Provenance): ToolResult<T> {
  return { data, provenance };
}

/**
 * A single step of an evidence bundle (§5): the tool that ran, what it was
 * asked, what it returned, and where that came from. The synthesis prompt
 * requires the model to attribute every figure it states to one of these.
 */
export interface EvidenceEntry {
  tool: string;
  params: Record<string, unknown>;
  data: unknown;
  provenance: Provenance;
}

export interface EvidenceBundle {
  workflow: string;
  userId: string;
  /** When the pipeline ran. Distinct from each entry's `asOf`. */
  generatedAt: string;
  entries: EvidenceEntry[];
}

export class EvidenceBuilder {
  private readonly entries: EvidenceEntry[] = [];

  constructor(
    private readonly workflow: string,
    private readonly userId: string,
  ) {}

  add<T>(tool: string, params: Record<string, unknown>, res: ToolResult<T>): T {
    this.entries.push({ tool, params, data: res.data, provenance: res.provenance });
    return res.data;
  }

  build(): EvidenceBundle {
    return {
      workflow: this.workflow,
      userId: this.userId,
      generatedAt: new Date().toISOString(),
      entries: [...this.entries],
    };
  }
}

/**
 * The PII-free reasoning trace persisted to `insight_log` (§3, §5). Tool names,
 * params, and provenance only — never the values. Evidence is regenerated live
 * when a user reopens a "why" card.
 */
export interface ReasoningTrace {
  workflow: string;
  toolCalls: Array<{
    tool: string;
    params: Record<string, unknown>;
    provenance: Provenance;
  }>;
}

export function toReasoningTrace(bundle: EvidenceBundle): ReasoningTrace {
  return {
    workflow: bundle.workflow,
    toolCalls: bundle.entries.map(({ tool, params, provenance }) => ({
      tool,
      params,
      provenance,
    })),
  };
}
