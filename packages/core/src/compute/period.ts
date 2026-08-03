/**
 * Period handling for transaction-scoped compute.
 *
 * `core` only ever accepts an explicit `{ from, to }` ISO date range (§4). It
 * does not understand "this month" or "last quarter" — turning a person's words
 * into concrete dates is the router/workflow layer's job, so that compute
 * functions stay pure date-range-in, figure-out.
 */

import type { SessionSnapshot, SnapshotTransaction } from '../snapshot.js';

export interface Period {
  /** Inclusive, YYYY-MM-DD. */
  from: string;
  /** Inclusive, YYYY-MM-DD. */
  to: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertPeriod(period: Period, tool: string): void {
  if (!ISO_DATE.test(period.from) || !ISO_DATE.test(period.to)) {
    throw new RangeError(
      `${tool}: period must be explicit YYYY-MM-DD dates, got ` +
        `{ from: ${period.from}, to: ${period.to} }. Resolve relative phrases ` +
        `("this month") before calling core.`,
    );
  }
  if (period.from > period.to) {
    throw new RangeError(`${tool}: period.from (${period.from}) is after period.to (${period.to}).`);
  }
}

export interface TransactionSelection {
  transactions: SnapshotTransaction[];
  notes: string[];
  accountIds: string[];
}

export interface SelectOptions {
  accountIds?: string[];
  /**
   * Internal movements between the user's own accounts appear twice — once
   * leaving, once arriving — and would inflate both sides of cash flow. Excluded
   * by default; the note says so, and callers analysing genuine external
   * transfers can opt back in.
   */
  excludeTransfers?: boolean;
  /**
   * Pending transactions can post later with a different amount, double-counting
   * against the settled version. Excluded by default.
   */
  includePending?: boolean;
}

const TRANSFER_CATEGORIES = new Set(['TRANSFER_IN', 'TRANSFER_OUT']);

/**
 * Filter the snapshot's transaction list down to a period, recording every
 * exclusion as a provenance note so the resulting figure is never quietly
 * narrower than the user assumes.
 */
export function selectTransactions(
  snapshot: SessionSnapshot,
  period: Period,
  options: SelectOptions = {},
): TransactionSelection {
  const { excludeTransfers = true, includePending = false } = options;
  const accountFilter = options.accountIds ? new Set(options.accountIds) : null;
  const notes: string[] = [];

  let pendingSkipped = 0;
  let transfersSkipped = 0;

  const transactions = snapshot.transactions.filter((t) => {
    if (t.date < period.from || t.date > period.to) return false;
    if (accountFilter && !accountFilter.has(t.accountId)) return false;
    if (!includePending && t.pending) {
      pendingSkipped += 1;
      return false;
    }
    if (excludeTransfers && t.category && TRANSFER_CATEGORIES.has(t.category.primary)) {
      transfersSkipped += 1;
      return false;
    }
    return true;
  });

  // The snapshot only holds the window that was fetched. Asking for figures
  // outside it yields a real but incomplete answer, which must be said.
  const window = snapshot.transactionWindow;
  if (!window) {
    notes.push('No transaction window was fetched for this session.');
  } else {
    if (period.from < window.from) {
      notes.push(
        `Transactions were only fetched back to ${window.from}, so anything before that ` +
          `is missing from this figure.`,
      );
    }
    if (period.to > window.to) {
      notes.push(
        `Transactions were only fetched through ${window.to}; nothing after that date is included.`,
      );
    }
  }

  if (transfersSkipped > 0) {
    notes.push(
      `${transfersSkipped} transfer(s) between your own accounts were excluded so they do ` +
        `not count as both income and spending.`,
    );
  }
  if (pendingSkipped > 0) {
    notes.push(`${pendingSkipped} pending transaction(s) were excluded until they post.`);
  }

  return {
    transactions,
    notes,
    accountIds: [...new Set(transactions.map((t) => t.accountId))],
  };
}
