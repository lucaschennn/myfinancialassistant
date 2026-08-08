/**
 * The request-scoped session snapshot (§7).
 *
 * §7 originally described one fetch per session. On Vercel that is not
 * available: each request may land on a fresh instance, so "in memory for the
 * life of the session" would silently become "in memory for the life of one
 * request" anyway. The MVP therefore commits to refetch-per-turn explicitly
 * rather than pretending to cache — no Redis, no KV, nothing financial at rest
 * even briefly (§9).
 *
 * The cost is real: every dashboard render and every chat turn pays a Plaid
 * round trip. That is the accepted tradeoff in §7, and it is the reason a TTL'd
 * cache is named there as a *later* optimisation rather than built now.
 *
 * The snapshot is an ordinary local binding. When the request ends it becomes
 * garbage — which is the whole of the "session end: discard" step.
 */

import { type Ctx, type SessionSnapshot, TraceRecorder } from '@pfg/core';
import type { Database } from '@pfg/db';
import { fetchSnapshot } from '@pfg/plaid';
import { plaidItems } from '@pfg/db';
import { and, eq } from 'drizzle-orm';
import { getWebDb, requireUser } from './auth';

export interface SnapshotCtx extends Ctx {
  userId: string;
  db: Database;
  snapshot: SessionSnapshot;
  trace: TraceRecorder;
}

export interface BuildSnapshotOptions {
  /** §7 suggests 90 days. Skipping transactions is much faster when unused. */
  transactionDays?: number;
  includeTransactions?: boolean;
  includeHoldings?: boolean;
  /** Pass an existing recorder to fold this fetch into a wider trace. */
  trace?: TraceRecorder;
}

/**
 * Fetch live Plaid data for the signed-in user and return a ctx carrying it.
 *
 * Note what is NOT here: any write of balances, holdings, or transactions. The
 * only thing a workflow persists is a derived aggregate (§3 Tier 1), and that
 * happens inside the workflow, not here.
 */
export async function requireSnapshotCtx(
  options: BuildSnapshotOptions = {},
): Promise<SnapshotCtx> {
  const user = await requireUser();
  const db = getWebDb();

  // One recorder per request, on the same lifecycle as the snapshot itself: it
  // is built here, read once when the response is assembled, and garbage after
  // (§0.2). Nothing about it is persisted.
  const trace = options.trace ?? new TraceRecorder();

  const snapshot = await fetchSnapshot({
    userId: user.id,
    db,
    transactionDays: options.transactionDays ?? 90,
    includeTransactions: options.includeTransactions ?? true,
    includeHoldings: options.includeHoldings ?? true,
    trace,
  });

  return { userId: user.id, db, snapshot, trace };
}

/**
 * Record the server-render span for a page.
 *
 * Server components have no `/api/...` request behind them, so without this a
 * trace would list Plaid and Postgres calls with nothing saying what asked for
 * them. Call it last: its duration is meant to cover the calls above it, and
 * the panel reports wall-clock rather than a sum, so the overlap is not
 * double-counted.
 */
export function traceRender(ctx: SnapshotCtx, label: string, startedMs: number): void {
  ctx.trace.add({
    scope: 'internal',
    label,
    startedAt: new Date(startedMs).toISOString(),
    durationMs: Date.now() - startedMs,
    ok: true,
    detail: 'server render',
  });
}

/**
 * Whether this user has linked anything yet.
 *
 * Reads `plaid_items` rather than calling Plaid: the answer to "should we show
 * the connect button or the dashboard?" should not cost a live fetch, and the
 * registry exists precisely so the UI can answer questions like this offline
 * (§3, `linked_accounts`).
 */
export async function hasLinkedItems(userId: string): Promise<boolean> {
  const rows = await getWebDb()
    .select({ id: plaidItems.id })
    .from(plaidItems)
    .where(and(eq(plaidItems.userId, userId), eq(plaidItems.status, 'active')))
    .limit(1);

  return rows.length > 0;
}
