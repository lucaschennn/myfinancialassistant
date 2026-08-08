/**
 * Live fetch → in-memory session snapshot (§7).
 *
 * Nothing here writes financial data to Postgres. The DB is touched only to
 * read which items a user has linked and to decrypt their access tokens.
 */

import type { SessionSnapshot, SnapshotAccount, SnapshotGap, SnapshotHolding, SnapshotSecurity, SnapshotTransaction, TraceRecorder } from '@pfg/core';
import { type Database, decryptToken, plaidItems } from '@pfg/db';
import { and, eq } from 'drizzle-orm';
import type { PlaidApi } from 'plaid';
import { createPlaidClient, describePlaidError } from './client.js';
import { normalizeAccount, normalizeHolding, normalizeSecurity, normalizeTransaction } from './normalize.js';

/** Plaid caps /transactions/get at 500 rows per page. */
const TRANSACTIONS_PAGE_SIZE = 500;

/**
 * A safety stop so a pathological account cannot spin the fetch loop forever.
 * 20 pages ≈ 10k transactions, far beyond a 90-day window for a real person.
 */
const MAX_TRANSACTION_PAGES = 20;

export interface FetchSnapshotOptions {
  userId: string;
  db: Database;
  plaid?: PlaidApi;
  /** How far back to pull transactions. §7 suggests 90 days. */
  transactionDays?: number;
  /** Skip the transactions call entirely — it is the slowest part of the fetch. */
  includeTransactions?: boolean;
  includeHoldings?: boolean;
  /** Overrides "today" for deterministic tests. */
  now?: Date;
  /**
   * Records what this fetch cost (§0.2). Optional — omitting it changes
   * nothing about the data returned.
   */
  trace?: TraceRecorder;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Fetch every linked item for a user and assemble one snapshot.
 *
 * Per-item failures degrade into `gaps` rather than throwing: one bank being
 * down should still let the user see the rest of their picture, with the
 * omission stated plainly (§6) instead of silently dropped.
 */
export async function fetchSnapshot(options: FetchSnapshotOptions): Promise<SessionSnapshot> {
  const {
    userId,
    db,
    plaid = createPlaidClient(),
    transactionDays = 90,
    includeTransactions = true,
    includeHoldings = true,
    now = new Date(),
    trace,
  } = options;

  // Report a call, or run it bare when no recorder was supplied. Keeping this
  // local means every call site below reads the same whether tracing is on or
  // off, rather than each one branching.
  const timed = <T>(
    scope: 'plaid' | 'db',
    label: string,
    fn: () => Promise<T>,
    describe?: (value: T) => { count?: number; detail?: string },
  ): Promise<T> => (trace ? trace.track(scope, label, fn, describe) : fn());

  const items = await timed(
    'db',
    'read linked items',
    () =>
      db
        .select()
        .from(plaidItems)
        .where(and(eq(plaidItems.userId, userId), eq(plaidItems.status, 'active'))),
    (rows) => ({ count: rows.length }),
  );

  const accounts: SnapshotAccount[] = [];
  const holdings: SnapshotHolding[] = [];
  const securities: SnapshotSecurity[] = [];
  const transactions: SnapshotTransaction[] = [];
  const gaps: SnapshotGap[] = [];
  const seenSecurityIds = new Set<string>();

  const to = isoDate(now);
  const from = isoDate(new Date(now.getTime() - transactionDays * 24 * 60 * 60 * 1000));

  for (const item of items) {
    const accessToken = decryptToken(item.accessTokenEncrypted);
    const institutionName = item.institutionName;
    const gapBase = { itemId: item.plaidItemId, institutionName };

    // --- Balances: the one call everything else depends on ------------------
    let itemAccounts: SnapshotAccount[] = [];
    try {
      const response = await timed(
        'plaid',
        '/accounts/balance/get',
        () => plaid.accountsBalanceGet({ access_token: accessToken }),
        (r) => ({ count: r.data.accounts.length, detail: institutionName ?? undefined }),
      );
      itemAccounts = response.data.accounts.map((a) =>
        normalizeAccount(a, { itemId: item.plaidItemId, institutionName }),
      );
      accounts.push(...itemAccounts);
    } catch (error) {
      const { message, code } = describePlaidError(error);
      gaps.push({ ...gapBase, dataset: 'balances', reason: message, ...(code ? { plaidErrorCode: code } : {}) });
      // With no accounts we cannot meaningfully ask for holdings or
      // transactions on this item either — move on.
      continue;
    }

    // --- Holdings: only for items that actually hold securities -------------
    // Asking a checking-only institution for holdings returns an error that
    // would otherwise be logged as a "gap", which is noise rather than a real
    // absence of data.
    const hasInvestmentAccounts = itemAccounts.some(
      (a) => a.type === 'investment' || a.type === 'brokerage',
    );
    if (includeHoldings && hasInvestmentAccounts) {
      try {
        const response = await timed(
          'plaid',
          '/investments/holdings/get',
          () => plaid.investmentsHoldingsGet({ access_token: accessToken }),
          (r) => ({ count: r.data.holdings.length, detail: institutionName ?? undefined }),
        );
        holdings.push(...response.data.holdings.map(normalizeHolding));
        for (const security of response.data.securities) {
          if (seenSecurityIds.has(security.security_id)) continue;
          seenSecurityIds.add(security.security_id);
          securities.push(normalizeSecurity(security));
        }
      } catch (error) {
        const { message, code } = describePlaidError(error);
        gaps.push({ ...gapBase, dataset: 'holdings', reason: message, ...(code ? { plaidErrorCode: code } : {}) });
      }
    }

    // --- Transactions -------------------------------------------------------
    if (includeTransactions) {
      try {
        transactions.push(
          ...(await fetchAllTransactions(plaid, accessToken, from, to, timed, institutionName)),
        );
      } catch (error) {
        const { message, code } = describePlaidError(error);
        gaps.push({ ...gapBase, dataset: 'transactions', reason: message, ...(code ? { plaidErrorCode: code } : {}) });
      }
    }
  }

  return {
    userId,
    fetchedAt: now.toISOString(),
    accounts,
    holdings,
    securities,
    transactions,
    transactionWindow: includeTransactions ? { from, to } : null,
    gaps,
  };
}

/** Every page is recorded separately — pagination is a real cost the user pays. */
type Timed = <T>(
  scope: 'plaid' | 'db',
  label: string,
  fn: () => Promise<T>,
  describe?: (value: T) => { count?: number; detail?: string },
) => Promise<T>;

async function fetchAllTransactions(
  plaid: PlaidApi,
  accessToken: string,
  from: string,
  to: string,
  timed: Timed,
  institutionName: string | null,
): Promise<SnapshotTransaction[]> {
  const collected: SnapshotTransaction[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_TRANSACTION_PAGES; page += 1) {
    const response = await timed(
      'plaid',
      '/transactions/get',
      () =>
        plaid.transactionsGet({
          access_token: accessToken,
          start_date: from,
          end_date: to,
          options: { count: TRANSACTIONS_PAGE_SIZE, offset },
        }),
      (r) => ({
        count: r.data.transactions.length,
        detail: [institutionName, page > 0 ? `page ${page + 1}` : null]
          .filter(Boolean)
          .join(', ') || undefined,
      }),
    );
    collected.push(...response.data.transactions.map(normalizeTransaction));
    offset += response.data.transactions.length;

    if (response.data.transactions.length === 0 || offset >= response.data.total_transactions) {
      break;
    }
  }

  return collected;
}
