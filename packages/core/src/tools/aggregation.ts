/**
 * Aggregation tools (§4). These read the in-memory session snapshot — they do
 * NOT query Postgres for financial data, because Postgres holds none (§0.4).
 *
 * They compute nothing beyond filtering: every derived figure comes from a
 * function in `compute/`.
 */

import { type Ctx, requireSnapshot } from '../context.js';
import type { Cents } from '../money.js';
import { type Provenance, type ToolResult, result } from '../provenance.js';
import {
  type AccountType,
  type SnapshotAccount,
  type SnapshotHolding,
  type SnapshotSecurity,
  type SnapshotTransaction,
  type SourceKind,
  describeSources,
  gapNotes,
  institutionNames,
  obtainedVia,
  sourcesOf,
  staleBalanceNotes,
  balanceOriginNotes,
} from '../snapshot.js';
import { type Period, type SelectOptions, assertPeriod, selectTransactions } from '../compute/period.js';

export interface AccountSummary {
  accountId: string;
  /** Where this account's data comes from: a live bank connection or your own records. */
  source: SourceKind;
  name: string;
  officialName: string | null;
  institutionName: string | null;
  mask: string | null;
  type: AccountType;
  subtype: string | null;
}

export interface ListAccountsData {
  accounts: AccountSummary[];
  institutions: string[];
}

/** listAccounts (§4): what is connected, with no balances attached. */
export function listAccounts(ctx: Ctx): ToolResult<ListAccountsData> {
  const snapshot = requireSnapshot(ctx, 'listAccounts');
  const notes = gapNotes(snapshot, 'balances');
  const sources = sourcesOf(snapshot.accounts);

  const provenance: Provenance = {
    source: obtainedVia(sources),
    asOf: snapshot.fetchedAt,
    accountIds: snapshot.accounts.map((a) => a.accountId),
    computation: `Every account from ${describeSources(sources)}.`,
    sources,
    ...(notes.length > 0 ? { notes } : {}),
  };

  return result(
    {
      accounts: snapshot.accounts.map((a) => ({
        accountId: a.accountId,
        source: a.source,
        name: a.name,
        officialName: a.officialName,
        institutionName: a.institutionName,
        mask: a.mask,
        type: a.type,
        subtype: a.subtype,
      })),
      institutions: institutionNames(snapshot),
    },
    provenance,
  );
}

export interface BalanceLine {
  accountId: string;
  source: SourceKind;
  /** When this balance was true: the fetch time for Plaid, the statement date for your own records. */
  balanceAsOf: string;
  name: string;
  institutionName: string | null;
  mask: string | null;
  type: AccountType;
  subtype: string | null;
  currentCents: Cents | null;
  availableCents: Cents | null;
  limitCents: Cents | null;
  isoCurrencyCode: string | null;
}

export interface GetBalancesData {
  balances: BalanceLine[];
}

export interface AccountFilterParams {
  accountIds?: string[];
}

function filterAccounts(accounts: SnapshotAccount[], accountIds?: string[]): SnapshotAccount[] {
  if (!accountIds) return accounts;
  const wanted = new Set(accountIds);
  return accounts.filter((a) => wanted.has(a.accountId));
}

/**
 * getBalances (§4). Balances are returned raw, with Plaid's sign convention
 * intact — a credit card's `currentCents` is a positive amount owed. Only
 * `netWorth` interprets that as negative.
 */
export function getBalances(
  ctx: Ctx,
  params: AccountFilterParams = {},
): ToolResult<GetBalancesData> {
  const snapshot = requireSnapshot(ctx, 'getBalances');
  const accounts = filterAccounts(snapshot.accounts, params.accountIds);
  const notes = [
    ...gapNotes(snapshot, 'balances'),
    ...balanceOriginNotes(snapshot, new Set(accounts.map((a) => a.accountId))),
    ...staleBalanceNotes(snapshot, new Set(accounts.map((a) => a.accountId))),
  ];
  const sources = sourcesOf(accounts);

  const provenance: Provenance = {
    source: obtainedVia(sources),
    asOf: snapshot.fetchedAt,
    accountIds: accounts.map((a) => a.accountId),
    computation:
      `Current, available, and limit balances from ${describeSources(sources)}, each as of its ` +
      'own date. Liability balances are positive amounts owed.',
    sources,
    ...(notes.length > 0 ? { notes } : {}),
  };

  return result(
    {
      balances: accounts.map((a) => ({
        accountId: a.accountId,
        source: a.source,
        balanceAsOf: a.balanceAsOf,
        name: a.name,
        institutionName: a.institutionName,
        mask: a.mask,
        type: a.type,
        subtype: a.subtype,
        currentCents: a.currentCents,
        availableCents: a.availableCents,
        limitCents: a.limitCents,
        isoCurrencyCode: a.isoCurrencyCode,
      })),
    },
    provenance,
  );
}

export interface GetHoldingsData {
  holdings: SnapshotHolding[];
  securities: SnapshotSecurity[];
}

/** getHoldings (§4): positions plus the securities they reference. */
export function getHoldings(
  ctx: Ctx,
  params: AccountFilterParams = {},
): ToolResult<GetHoldingsData> {
  const snapshot = requireSnapshot(ctx, 'getHoldings');
  const wanted = params.accountIds ? new Set(params.accountIds) : null;
  const holdings = wanted
    ? snapshot.holdings.filter((h) => wanted.has(h.accountId))
    : snapshot.holdings;

  // Only ship the securities actually referenced — the full security list can
  // be much larger than the user's positions.
  const referenced = new Set(holdings.map((h) => h.securityId));
  const securities = snapshot.securities.filter((s) => referenced.has(s.securityId));
  const notes = gapNotes(snapshot, 'holdings');
  const sources = holdings.length > 0 ? sourcesOf(holdings) : snapshot.sources;

  const provenance: Provenance = {
    source: obtainedVia(sources),
    asOf: snapshot.fetchedAt,
    accountIds: [...new Set(holdings.map((h) => h.accountId))],
    computation: `Investment positions and their securities from ${describeSources(sources)}.`,
    sources,
    ...(notes.length > 0 ? { notes } : {}),
  };

  return result({ holdings, securities }, provenance);
}

export interface GetTransactionsParams extends SelectOptions {
  from: string;
  to: string;
  /** Filter by Plaid `personal_finance_category.primary`. */
  categories?: string[];
}

export interface GetTransactionsData {
  transactions: SnapshotTransaction[];
  period: Period;
  count: number;
}

/**
 * getTransactions (§4). The window is bounded by what the snapshot fetched;
 * asking for a wider range yields a provenance note rather than silence.
 */
export function getTransactions(
  ctx: Ctx,
  params: GetTransactionsParams,
): ToolResult<GetTransactionsData> {
  const snapshot = requireSnapshot(ctx, 'getTransactions');
  const { from, to, categories, ...selectOptions } = params;
  const period: Period = { from, to };
  assertPeriod(period, 'getTransactions');

  const selection = selectTransactions(snapshot, period, selectOptions);
  const categoryFilter = categories ? new Set(categories) : null;
  const transactions = categoryFilter
    ? selection.transactions.filter((t) => t.category && categoryFilter.has(t.category.primary))
    : selection.transactions;

  const notes = [...gapNotes(snapshot, 'transactions'), ...selection.notes];
  const sources = transactions.length > 0 ? sourcesOf(transactions) : snapshot.sources;

  const provenance: Provenance = {
    source: obtainedVia(sources),
    asOf: snapshot.fetchedAt,
    accountIds: [...new Set(transactions.map((t) => t.accountId))],
    period,
    computation:
      `Transactions from ${describeSources(sources)}, filtered to the requested date range` +
      (categoryFilter ? ' and categories.' : '.') +
      ' Positive amounts are money leaving the account.',
    sources,
    ...(notes.length > 0 ? { notes } : {}),
  };

  return result({ transactions, period, count: transactions.length }, provenance);
}
