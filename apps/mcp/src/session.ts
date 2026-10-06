/**
 * Session state for the MCP dev harness.
 *
 * Unlike the app path — where Vercel's statelessness forces a refetch per chat
 * turn (§7) — this is a long-lived local process, so a genuine in-memory
 * session snapshot can span many tool calls. That is the one place the spec's
 * original "one fetch per session" model actually holds.
 *
 * The snapshot still never touches disk.
 */

import { type Ctx, type SessionSnapshot, mergeSources, transactionWindowFor } from '@pfg/core';
import { type Database, getDb } from '@pfg/db';
import { readManualSource } from '@pfg/ingest';
import { fetchPlaidSource } from '@pfg/plaid';

export interface HarnessConfig {
  userId: string;
  transactionDays: number;
  /** How long a snapshot is reused before the next tool call refetches. */
  ttlMs: number;
}

export class MisconfiguredHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MisconfiguredHarnessError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function loadHarnessConfig(): HarnessConfig {
  // The dev token is not a security boundary — stdio transport is already local
  // and unauthenticated. It is a deliberate "yes, I meant to run this" switch,
  // so the harness cannot be started by accident against a populated database.
  if (!process.env.MCP_DEV_TOKEN) {
    throw new MisconfiguredHarnessError(
      'MCP_DEV_TOKEN is not set. This server is a local dev harness (§2) — set the ' +
        'variable in .env to confirm you intend to run it.',
    );
  }

  const userId = process.env.MCP_DEV_USER_ID;
  if (!userId) {
    throw new MisconfiguredHarnessError(
      'MCP_DEV_USER_ID is not set. Run `npm run link:sandbox` and put the UUID it ' +
        'prints into .env.',
    );
  }
  if (!UUID.test(userId)) {
    throw new MisconfiguredHarnessError(
      `MCP_DEV_USER_ID must be the users.id UUID, not "${userId}". Run ` +
        '`npm run link:sandbox` to create a sandbox user and print its id.',
    );
  }

  return {
    userId,
    transactionDays: Number(process.env.MCP_TRANSACTION_DAYS ?? 90),
    ttlMs: Number(process.env.MCP_SNAPSHOT_TTL_MS ?? 10 * 60 * 1000),
  };
}

export class Session {
  private snapshot: SessionSnapshot | null = null;
  private fetchedAtMs = 0;
  private inFlight: Promise<SessionSnapshot> | null = null;
  private readonly db: Database;

  constructor(private readonly config: HarnessConfig) {
    this.db = getDb();
  }

  get userId(): string {
    return this.config.userId;
  }

  private isStale(): boolean {
    return !this.snapshot || Date.now() - this.fetchedAtMs > this.config.ttlMs;
  }

  /**
   * Get the current snapshot, fetching if absent or stale. Concurrent tool
   * calls share one in-flight fetch rather than each hammering Plaid.
   */
  async getSnapshot(forceRefresh = false): Promise<SessionSnapshot> {
    if (!forceRefresh && !this.isStale() && this.snapshot) return this.snapshot;
    this.inFlight ??= this.fetch().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetch(): Promise<SessionSnapshot> {
    const now = new Date();
    const [plaid, manual] = await Promise.all([
      fetchPlaidSource({
        userId: this.config.userId,
        db: this.db,
        transactionDays: this.config.transactionDays,
        now,
      }),
      readManualSource({
        userId: this.config.userId,
        db: this.db,
        transactionWindow: transactionWindowFor(this.config.transactionDays, now),
      }),
    ]);
    const snapshot = mergeSources(this.config.userId, [plaid, manual], now);
    this.snapshot = snapshot;
    this.fetchedAtMs = Date.now();
    return snapshot;
  }

  /** Discard the snapshot — the §7 "session end" step, available on demand. */
  clear(): void {
    this.snapshot = null;
    this.fetchedAtMs = 0;
  }

  /** A ctx carrying live data, for tools that read the snapshot. */
  async ctx(forceRefresh = false): Promise<Required<Pick<Ctx, 'userId' | 'snapshot' | 'db'>>> {
    return { userId: this.config.userId, snapshot: await this.getSnapshot(forceRefresh), db: this.db };
  }

  /** A ctx without a snapshot, for DB-only tools that should not trigger a fetch. */
  dbCtx(): Ctx {
    return { userId: this.config.userId, db: this.db };
  }

  status(): { userId: string; hasSnapshot: boolean; fetchedAt: string | null; stale: boolean } {
    return {
      userId: this.config.userId,
      hasSnapshot: this.snapshot !== null,
      fetchedAt: this.snapshot?.fetchedAt ?? null,
      stale: this.isStale(),
    };
  }
}
