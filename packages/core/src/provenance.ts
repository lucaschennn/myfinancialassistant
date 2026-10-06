/**
 * Provenance (§0.2): every figure the system produces carries a record of where
 * it came from. This is structural, not a prompt instruction — a tool result is
 * literally unable to exist without one, because `ToolResult` requires it.
 */

import type { SourceKind } from './snapshot.js';

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
  /**
   * Data origins behind this figure (§4). `source` says HOW the figure was
   * obtained (a live fetch, a DB read, a computation); this says WHERE the
   * underlying data came from. A merged net worth is `source: 'compute'` and
   * `sources: ['plaid', 'manual']`, and both facts are worth stating.
   */
  sources?: SourceKind[];
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

/**
 * Params can themselves be money. `fireProgress` takes `annualSpendCents`, and
 * that is the user's own target — a financial figure, not a tool name. Copying
 * params verbatim into the trace would put it in `insight_log` and make the
 * audit log the PII store §3 says it must not become.
 *
 * Redacted by suffix, matching the convention `humanize()` relies on: any key
 * ending in `Cents` is money by construction.
 *
 * Phase 2 note, for whoever writes the insight_log writer (Phase 3): a
 * `documentId` is a safe reference, but an uploaded document's ORIGINAL
 * FILENAME is not — real ones read `chase_statement_4412_aug2026.pdf` and carry
 * an account number. Add filenames to these rules at the same time as the writer.
 */
function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key.endsWith('Cents')) {
      // Record that the parameter was supplied, never what it was — the shape
      // of the reasoning survives, the figure does not.
      out[key] = '[redacted]';
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redactParams(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function toReasoningTrace(bundle: EvidenceBundle): ReasoningTrace {
  return {
    workflow: bundle.workflow,
    toolCalls: bundle.entries.map(({ tool, params, provenance }) => ({
      tool,
      params: redactParams(params),
      provenance,
    })),
  };
}
