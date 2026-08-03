/**
 * The context object threaded through every core tool (§4). User scoping is
 * enforced here by convention (§3 Isolation): a tool receives `ctx` and every
 * DB query it makes filters on `ctx.userId`. Postgres RLS is a Phase 2 addition
 * on top of this, not a replacement for it.
 */

import type { Database } from '@pfg/db';
import type { SessionSnapshot } from './snapshot.js';

export interface Ctx {
  userId: string;
  /**
   * Live Plaid data for this request. Absent for tools that only touch
   * Postgres (profile, goals) — those work without a Plaid fetch.
   */
  snapshot?: SessionSnapshot;
  db?: Database;
}

export class MissingSnapshotError extends Error {
  constructor(tool: string) {
    super(
      `${tool} needs a session snapshot. Fetch live Plaid data with ` +
        `fetchSnapshot() and pass it on ctx before calling this tool.`,
    );
    this.name = 'MissingSnapshotError';
  }
}

export class MissingDatabaseError extends Error {
  constructor(tool: string) {
    super(`${tool} needs a database handle on ctx.`);
    this.name = 'MissingDatabaseError';
  }
}

/**
 * Cross-user leakage would be the worst bug this codebase could have, so the
 * snapshot's owner is re-checked at every read rather than trusted from the
 * point it was built.
 */
export class SnapshotOwnershipError extends Error {
  constructor(tool: string, ctxUserId: string, snapshotUserId: string) {
    super(
      `${tool}: snapshot belongs to user ${snapshotUserId} but ctx is user ` +
        `${ctxUserId}. Refusing to compute across users.`,
    );
    this.name = 'SnapshotOwnershipError';
  }
}

export function requireSnapshot(ctx: Ctx, tool: string): SessionSnapshot {
  if (!ctx.snapshot) throw new MissingSnapshotError(tool);
  if (ctx.snapshot.userId !== ctx.userId) {
    throw new SnapshotOwnershipError(tool, ctx.userId, ctx.snapshot.userId);
  }
  return ctx.snapshot;
}

export function requireDb(ctx: Ctx, tool: string): Database {
  if (!ctx.db) throw new MissingDatabaseError(tool);
  return ctx.db;
}
