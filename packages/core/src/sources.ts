/**
 * Sources and the merge (§1, §7). The session snapshot is no longer "the result
 * of a Plaid fetch" — it is the merge of every source the user has. Plaid is one
 * source, fetched live and never stored; the manual ledger is another, stored
 * because nothing else holds it (§0.4).
 *
 * Every compute function reads the merged snapshot and does not care which
 * source an account came from, except to report it in provenance. That is the
 * seam that lets a user with no bank connected get the same product.
 */

import type {
  SessionSnapshot,
  SnapshotAccount,
  SnapshotGap,
  SnapshotHolding,
  SnapshotSecurity,
  SnapshotTransaction,
  SourceKind,
} from './snapshot.js';

/** What one source contributes to a snapshot, before merging. */
export interface SourceResult {
  kind: SourceKind;
  accounts: SnapshotAccount[];
  holdings: SnapshotHolding[];
  securities: SnapshotSecurity[];
  transactions: SnapshotTransaction[];
  /** The window this source was asked for. `null` when it did not read transactions. */
  transactionWindow: { from: string; to: string } | null;
  gaps: SnapshotGap[];
}

const MANUAL_PREFIX = 'manual_';

/**
 * Manual ids are the DB uuid prefixed `manual_`, so they cannot collide with a
 * Plaid id. A collision would merge or drop an account with nothing erroring —
 * a silently wrong net worth — so the prefix makes it structurally impossible,
 * and `mergeSources` asserts it anyway.
 */
export function manualAccountId(uuid: string): string {
  return `${MANUAL_PREFIX}${uuid}`;
}

export function manualSecurityId(uuid: string): string {
  return `${MANUAL_PREFIX}${uuid}`;
}

export function isManualAccountId(id: string): boolean {
  return id.startsWith(MANUAL_PREFIX);
}

/** The DB uuid behind a `manual_` id, or null if the id is not a manual one. */
export function manualUuid(id: string): string | null {
  return isManualAccountId(id) ? id.slice(MANUAL_PREFIX.length) : null;
}

export class DuplicateAccountIdError extends Error {
  constructor(accountId: string, kinds: SourceKind[]) {
    super(
      `Account id "${accountId}" appears in more than one source (${kinds.join(', ')}). ` +
        'Refusing to merge: a duplicate would double-count or silently drop an account.',
    );
    this.name = 'DuplicateAccountIdError';
  }
}

/**
 * Merge every source's result into one snapshot. Pure.
 *
 * Rules, each tested:
 *  1. Account ids must be unique across sources. Throw, never dedupe.
 *  2. `transactionWindow` is the INTERSECTION of the windows sources were asked
 *     for. A union would let `cashFlow` describe a period one source cannot
 *     speak to as if it were fully covered. Transactions outside the
 *     intersection are dropped, and the drop is stated as a gap.
 *  3. Securities dedupe by id, as the Plaid fetch already does within itself.
 *  4. `sources` lists the kinds that returned at least one account.
 *  5. Gaps concatenate, keeping their source.
 */
export function mergeSources(
  userId: string,
  results: SourceResult[],
  now: Date = new Date(),
): SessionSnapshot {
  const owner = new Map<string, SourceKind>();
  for (const r of results) {
    for (const a of r.accounts) {
      const prior = owner.get(a.accountId);
      if (prior !== undefined) throw new DuplicateAccountIdError(a.accountId, [prior, r.kind]);
      owner.set(a.accountId, r.kind);
    }
  }

  const gaps: SnapshotGap[] = results.flatMap((r) => r.gaps);

  // Only sources that actually contributed accounts get a say in the window: an
  // empty ledger must not narrow the period a connected bank can speak to.
  const windows = results
    .filter((r) => r.accounts.length > 0)
    .map((r) => ({ kind: r.kind, window: r.transactionWindow }))
    .filter((w): w is { kind: SourceKind; window: { from: string; to: string } } => w.window !== null);

  let transactionWindow: { from: string; to: string } | null = null;
  if (windows.length > 0) {
    const from = windows.map((w) => w.window.from).reduce((a, b) => (a > b ? a : b));
    const to = windows.map((w) => w.window.to).reduce((a, b) => (a < b ? a : b));
    if (from <= to) {
      transactionWindow = { from, to };
    } else {
      gaps.push({
        source: windows[0]!.kind,
        itemId: 'merge',
        institutionName: null,
        dataset: 'transactions',
        reason:
          'Your sources cover transaction periods that do not overlap, so no single period ' +
          'is fully covered and transaction figures are left out rather than shown incomplete.',
      });
    }
    for (const w of windows) {
      if (transactionWindow && (w.window.from < transactionWindow.from || w.window.to > transactionWindow.to)) {
        gaps.push({
          source: w.kind,
          itemId: 'merge',
          institutionName: null,
          dataset: 'transactions',
          reason:
            `${w.kind === 'plaid' ? 'Plaid' : 'Your own records'} also cover ` +
            `${w.window.from} to ${w.window.to}, but only ${transactionWindow.from} to ` +
            `${transactionWindow.to} is covered by every source, so only that period is used.`,
        });
      }
    }
  }

  const inWindow = (t: SnapshotTransaction): boolean =>
    transactionWindow !== null && t.date >= transactionWindow.from && t.date <= transactionWindow.to;

  const securities: SnapshotSecurity[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    for (const s of r.securities) {
      if (seen.has(s.securityId)) continue;
      seen.add(s.securityId);
      securities.push(s);
    }
  }

  return {
    userId,
    fetchedAt: now.toISOString(),
    sources: (['plaid', 'manual'] as const).filter((k) =>
      results.some((r) => r.kind === k && r.accounts.length > 0),
    ),
    accounts: results.flatMap((r) => r.accounts),
    holdings: results.flatMap((r) => r.holdings),
    securities,
    transactions: results.flatMap((r) => r.transactions).filter(inWindow),
    transactionWindow,
    gaps,
  };
}

/**
 * The window every source is asked for: the `days` before `now`, inclusive,
 * in UTC dates. One function so Plaid and the manual ledger are asked for the
 * identical range — otherwise the merge's intersection would silently shave a
 * day off whichever computed its edge differently.
 */
export function transactionWindowFor(days: number, now: Date = new Date()): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { from, to };
}
