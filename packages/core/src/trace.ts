/**
 * The network trace (§0.2, §8 Phase 1.5).
 *
 * §7 refetches from Plaid on every render and every chat turn rather than
 * caching, which is a deliberate data-minimisation tradeoff: we hold no raw
 * financial PII at rest, and pay for it in latency. That cost is real and the
 * user pays it, so it is disclosed rather than hidden behind a spinner.
 *
 * What this records is deliberately thin: WHICH call, HOW LONG, DID IT WORK,
 * HOW MANY ITEMS. Never a payload, never a token, never an account identifier.
 * A panel that leaked request bodies to prove we are transparent would be a
 * worse breach of §9 than not having the panel at all.
 *
 * Lifecycle matches the session snapshot exactly: request-scoped, discarded
 * when the request ends, regenerated per turn. It is never persisted, and never
 * reaches `insight_log`.
 */

/**
 * Where the work happened.
 *
 * `internal` is our own server work — a route handler or a server-component
 * render. Note there is not always an HTTP request behind it: the dashboard is
 * a server component that calls Plaid during render, so its trace describes
 * work done for a view, not requests the browser made. That distinction is
 * surfaced in the UI copy rather than papered over.
 */
export type TraceScope = 'internal' | 'plaid' | 'anthropic' | 'db';

export interface TraceEntry {
  scope: TraceScope;
  /** What was called: `accountsBalanceGet`, `claude-sonnet-5`, `POST /api/chat`. */
  label: string;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  /** Items returned, where the count is meaningful (accounts, transactions). */
  count?: number;
  /**
   * A short, human-readable qualifier — "page 2", "retry after attribution
   * failure", "no investment accounts". Never a payload or an error body: a
   * Plaid error message can quote the request that produced it.
   */
  detail?: string;
}

export interface NetworkTrace {
  entries: TraceEntry[];
  /** Wall-clock span from the first call starting to the last one finishing. */
  totalMs: number;
  /** Per-scope totals, so the UI does not have to derive them. */
  byScope: Array<{ scope: TraceScope; calls: number; totalMs: number }>;
}

export const EMPTY_TRACE: NetworkTrace = { entries: [], totalMs: 0, byScope: [] };

/**
 * Collects trace entries for one request.
 *
 * Recording happens at the boundary that makes the call — the Plaid client, the
 * Anthropic client, the route handler — never in the UI. A trace the UI infers
 * would be a claim about the system rather than a record of it, which is the
 * exact failure mode §0.2 exists to prevent.
 */
export class TraceRecorder {
  private readonly entries: TraceEntry[] = [];

  /**
   * Time an async call and record it, whether it succeeds or throws.
   *
   * The error is re-thrown untouched: this is an observer, and swallowing a
   * failure to keep the trace tidy would change behaviour to serve reporting.
   */
  async track<T>(
    scope: TraceScope,
    label: string,
    fn: () => Promise<T>,
    describe?: (value: T) => { count?: number; detail?: string },
  ): Promise<T> {
    const startedAt = new Date();
    const began = performance.now();
    try {
      const value = await fn();
      this.entries.push({
        scope,
        label,
        startedAt: startedAt.toISOString(),
        durationMs: Math.round(performance.now() - began),
        ok: true,
        ...(describe ? describe(value) : {}),
      });
      return value;
    } catch (error) {
      this.entries.push({
        scope,
        label,
        startedAt: startedAt.toISOString(),
        durationMs: Math.round(performance.now() - began),
        ok: false,
        // Deliberately not the error message — Plaid errors can quote the
        // request body. The gap notes on the snapshot carry the human reason.
        detail: 'failed',
      });
      throw error;
    }
  }

  /** Record something already measured, or something with no async call to wrap. */
  add(entry: TraceEntry): void {
    this.entries.push(entry);
  }

  /** Note an event on the most recently recorded call. */
  annotate(detail: string): void {
    const last = this.entries[this.entries.length - 1];
    if (last) last.detail = last.detail ? `${last.detail}, ${detail}` : detail;
  }

  build(): NetworkTrace {
    const entries = [...this.entries].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    if (entries.length === 0) return EMPTY_TRACE;

    const byScope = new Map<TraceScope, { scope: TraceScope; calls: number; totalMs: number }>();
    for (const entry of entries) {
      const bucket = byScope.get(entry.scope) ?? { scope: entry.scope, calls: 0, totalMs: 0 };
      bucket.calls += 1;
      bucket.totalMs += entry.durationMs;
      byScope.set(entry.scope, bucket);
    }

    // Wall-clock, not the sum of durations: calls may overlap, and a sum would
    // overstate what the user actually waited for.
    const first = entries[0]!;
    const startedMs = Date.parse(first.startedAt);
    const endedMs = Math.max(
      ...entries.map((e) => Date.parse(e.startedAt) + e.durationMs),
    );

    return {
      entries,
      totalMs: Math.max(0, endedMs - startedMs),
      byScope: [...byScope.values()],
    };
  }
}

/*
 * Deliberately no SCOPE_LABELS export here. Display labels belong to whatever
 * renders a trace, not to `core`: the only consumer is a component reachable
 * from a client component, and importing a runtime value from `@pfg/core` drags
 * `@pfg/db` and `postgres` into the browser bundle. Types are erased and safe;
 * values are not. See apps/web/src/app/NetworkPanel.tsx.
 */
