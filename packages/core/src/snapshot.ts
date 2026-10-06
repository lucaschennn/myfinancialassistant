/**
 * The session snapshot (§7): every source's financial data, merged and held in
 * memory for the life of one request, then discarded. Plaid rows in it have no
 * durable form at all (§0.4); manual rows are a *read* of the ledger the user
 * built from their own documents, which is stored because nothing else holds it.
 *
 * On Vercel the "session" is a single chat turn: each turn refetches. Under the
 * MCP dev harness the process is long-lived, so one snapshot can genuinely span
 * many tool calls.
 */

import type { Cents } from './money.js';

/**
 * Where a row's data came from (§0.4, §7). Plaid is fetched live and never
 * stored; `manual` is the ledger built from the user's own documents and typed
 * entries, stored because there is nothing to refetch it from. Required on every
 * row rather than defaulted, so no construction site can forget to say which.
 */
export type SourceKind = 'plaid' | 'manual';

/** Plaid's top-level account taxonomy. */
export type AccountType = 'depository' | 'investment' | 'credit' | 'loan' | 'brokerage' | 'other';

/** Account types whose balance is money owed, not money held. */
export const LIABILITY_TYPES: ReadonlySet<AccountType> = new Set<AccountType>(['credit', 'loan']);

/**
 * Types that count toward FIRE progress (§4). Real estate and vehicles roll up
 * into `netWorth` but are excluded here — you cannot draw 4% a year off a house
 * you live in. Plaid reports both as `other`, which is why `other` is out.
 */
export const INVESTABLE_ASSET_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'investment',
  'depository',
  'brokerage',
]);

/**
 * Loan subtypes secured against housing — the asset `fireProgress` already
 * excludes. Subtracting this debt while ignoring the property it bought would
 * charge the user for the same house twice: once here, and again inside the
 * annual spend target that the mortgage payment is part of.
 *
 * Deliberately narrow. Auto and student loans stay subtracted: their payments
 * are not structurally baked into a long-run retirement spending target the way
 * housing costs are, and the assets behind them (if present at all) are not
 * reliably visible to us.
 */
export const ILLIQUID_SECURED_LOAN_SUBTYPES: ReadonlySet<string> = new Set([
  'mortgage',
  'home equity',
]);

/** True when a liability is secured against an asset FIRE progress ignores. */
export function isIlliquidSecuredDebt(account: {
  type: AccountType;
  subtype: string | null;
}): boolean {
  if (account.type !== 'loan') return false;
  return ILLIQUID_SECURED_LOAN_SUBTYPES.has((account.subtype ?? '').toLowerCase());
}

export interface SnapshotAccount {
  source: SourceKind;
  accountId: string;
  itemId: string;
  institutionName: string | null;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: AccountType;
  subtype: string | null;
  /**
   * Plaid's `balances.current`. For liability accounts this is a POSITIVE
   * amount owed — the sign flip into "negative net worth contribution" happens
   * in `netWorth`, deliberately in one place rather than at normalisation time.
   */
  currentCents: Cents | null;
  availableCents: Cents | null;
  limitCents: Cents | null;
  isoCurrencyCode: string | null;
  /**
   * When this account's balance was true. For Plaid this is the snapshot fetch
   * time; for a manual account it is the statement date, which may be months
   * old. Required, not optional, so that no caller can forget to consider it.
   */
  balanceAsOf: string;
  /**
   * Manual accounts only: the document the current balance came from, so
   * evidence can name it (Checkpoint 2: "evidence naming the document").
   * Named by kind and import date — NEVER by filename, which is
   * attacker-controlled and on real statements carries an account number.
   */
  balanceDocument?: { documentId: string; kind: 'csv' | 'pdf' | 'manual_entry'; importedOn: string } | null;
}

export interface SnapshotSecurity {
  source: SourceKind;
  securityId: string;
  name: string | null;
  tickerSymbol: string | null;
  /** Plaid: cash | cryptocurrency | derivative | equity | etf | fixed income | loan | mutual fund | other */
  type: string | null;
  closePriceCents: Cents | null;
  isCashEquivalent: boolean;
}

export interface SnapshotHolding {
  source: SourceKind;
  accountId: string;
  securityId: string;
  /** Share count — genuinely fractional, and not money, so not cents. */
  quantity: number;
  costBasisCents: Cents | null;
  /** Plaid's `institution_value`: quantity × price, as the institution reports it. */
  valueCents: Cents;
  isoCurrencyCode: string | null;
}

export interface TransactionCategory {
  /** Plaid `personal_finance_category.primary`, e.g. FOOD_AND_DRINK. */
  primary: string;
  /** Plaid `personal_finance_category.detailed`, e.g. FOOD_AND_DRINK_FAST_FOOD. */
  detailed: string;
}

export interface SnapshotTransaction {
  source: SourceKind;
  transactionId: string;
  accountId: string;
  /** YYYY-MM-DD, the transaction's posted date. */
  date: string;
  /**
   * PLAID SIGN CONVENTION, preserved as-is: positive = money leaving the
   * account (a purchase), negative = money arriving (a deposit). This is the
   * opposite of what most people expect, so it is normalised nowhere and
   * interpreted explicitly in `cashFlow`/`savingsRate` instead.
   */
  amountCents: Cents;
  name: string;
  merchantName: string | null;
  pending: boolean;
  category: TransactionCategory | null;
  isoCurrencyCode: string | null;
}

/**
 * Something the snapshot could not see. Surfaced so the guru can say "I don't
 * have investment data from this institution yet" (§6) instead of quietly
 * computing a net worth that is missing an account.
 */
export interface SnapshotGap {
  source: SourceKind;
  itemId: string;
  institutionName: string | null;
  /** Which dataset is missing. `documents`: an import that could not be read. */
  dataset: 'balances' | 'holdings' | 'transactions' | 'documents';
  reason: string;
  /** Plaid error code, when the failure came back structured. */
  plaidErrorCode?: string;
}

export interface SessionSnapshot {
  /** Whose data this is. Every tool asserts this matches `ctx.userId` (§3). */
  userId: string;
  /** ISO 8601 — when this snapshot was assembled. Becomes `provenance.asOf`. */
  fetchedAt: string;
  /** Which sources contributed at least one account. Empty means nothing is connected. */
  sources: SourceKind[];
  accounts: SnapshotAccount[];
  holdings: SnapshotHolding[];
  securities: SnapshotSecurity[];
  transactions: SnapshotTransaction[];
  /**
   * The window every contributing source can speak to — the intersection, not
   * the union (see `mergeSources`), so a figure never describes a period one
   * source has no data for as if it were fully covered.
   */
  transactionWindow: { from: string; to: string } | null;
  gaps: SnapshotGap[];
}

export function emptySnapshot(userId: string): SessionSnapshot {
  return {
    userId,
    fetchedAt: new Date().toISOString(),
    sources: [],
    accounts: [],
    holdings: [],
    securities: [],
    transactions: [],
    transactionWindow: null,
    gaps: [],
  };
}

/** Index securities by id for the O(1) lookups `assetAllocation` needs. */
export function securityIndex(snapshot: SessionSnapshot): Map<string, SnapshotSecurity> {
  return new Map(snapshot.securities.map((s) => [s.securityId, s]));
}

export function accountIndex(snapshot: SessionSnapshot): Map<string, SnapshotAccount> {
  return new Map(snapshot.accounts.map((a) => [a.accountId, a]));
}

/** Institutions the snapshot drew from, for provenance notes. */
export function institutionNames(snapshot: SessionSnapshot): string[] {
  const names = new Set<string>();
  for (const a of snapshot.accounts) {
    if (a.institutionName) names.add(a.institutionName);
  }
  return [...names].sort();
}

/**
 * Render gaps as provenance notes. Every compute function attaches the gaps
 * relevant to its dataset, so incompleteness travels with the figure.
 */
export function gapNotes(snapshot: SessionSnapshot, dataset: SnapshotGap['dataset']): string[] {
  return snapshot.gaps
    .filter((g) => g.dataset === dataset)
    .map((g) => `No ${dataset} from ${g.institutionName ?? g.itemId}: ${g.reason}`);
}

/** Default age, in days, past which a balance is called out as older than the rest. */
export const STALE_AFTER_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Accounts whose balance is older than `staleAfterDays` relative to the
 * snapshot's fetch time (§4). A manual balance dated 31 August merged with a
 * Plaid balance fetched this morning makes a total that is true as of no single
 * moment, and that has to be said rather than hidden behind one timestamp.
 */
export function staleAccounts(
  snapshot: SessionSnapshot,
  staleAfterDays: number = STALE_AFTER_DAYS,
): SnapshotAccount[] {
  // Whole calendar days, comparing dates rather than instants: a statement
  // dated 28 September is exactly 7 days before 5 October whether the fetch ran
  // at 00:01 or 23:59, and the time of day must not tip it into "stale".
  const day = (iso: string): number => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  const fetched = day(snapshot.fetchedAt);
  return snapshot.accounts.filter((a) => {
    if (a.currentCents === null) return false;
    const asOf = day(a.balanceAsOf);
    return Number.isFinite(asOf) && fetched - asOf > staleAfterDays * DAY_MS;
  });
}

/**
 * Staleness as provenance notes, written as information rather than a warning:
 * someone deliberately tracking an account by statement should not be nagged
 * about it on every figure (§6: proactive, not alarmist).
 */
export function staleBalanceNotes(
  snapshot: SessionSnapshot,
  accountIds?: ReadonlySet<string>,
): string[] {
  return staleAccounts(snapshot)
    .filter((a) => !accountIds || accountIds.has(a.accountId))
    .map(
      (a) =>
        `${a.name}${a.mask ? ` (…${a.mask})` : ''}'s balance is as of ${a.balanceAsOf.slice(0, 10)}` +
        (a.source === 'manual' ? ', from your own records' : '') +
        `, older than the rest of this snapshot (${snapshot.fetchedAt.slice(0, 10)}).`,
    );
}

/**
 * Where each manual balance came from, as one provenance note: the document
 * by kind and import date, or "entered by hand". Plaid accounts need no such
 * note — the source badge and `sources` already say "live".
 */
export function balanceOriginNotes(snapshot: SessionSnapshot, accountIds?: ReadonlySet<string>): string[] {
  const parts = snapshot.accounts
    .filter((a) => a.source === 'manual' && a.currentCents !== null && (!accountIds || accountIds.has(a.accountId)))
    .map((a) => {
      const label = `${a.name}${a.mask ? ` (…${a.mask})` : ''}`;
      const doc = a.balanceDocument;
      if (!doc || doc.kind === 'manual_entry') return `${label}, entered by hand`;
      return `${label}, from the ${doc.kind === 'pdf' ? 'PDF statement' : 'CSV export'} imported ${doc.importedOn}`;
    });
  return parts.length > 0 ? [`From your own records: ${parts.join('; ')}.`] : [];
}

/** The distinct sources behind a set of rows, in a stable order. */
export function sourcesOf(rows: ReadonlyArray<{ source: SourceKind }>): SourceKind[] {
  const present = new Set(rows.map((r) => r.source));
  return (['plaid', 'manual'] as const).filter((k) => present.has(k));
}

/**
 * Plain-language origin of a set of rows, for provenance `computation` text.
 * Derived from the rows actually involved rather than hard-coded, because a
 * sentence that says "from Plaid" over a statement the user uploaded is the
 * quiet wrongness §0.2 exists to prevent (§4).
 */
export function describeSources(kinds: readonly SourceKind[]): string {
  const hasPlaid = kinds.includes('plaid');
  const hasManual = kinds.includes('manual');
  if (hasPlaid && hasManual) return 'Plaid (fetched live) and your own records (statements and typed entries)';
  if (hasManual) return 'your own records (statements and typed entries)';
  if (hasPlaid) return 'Plaid (fetched live)';
  return 'no connected source';
}

/**
 * How a set of rows was obtained, on the `ProvenanceSource` axis: Plaid rows
 * are a live fetch, manual rows a read of the stored ledger. A mix reports
 * `plaid` and relies on `provenance.sources` to say "both" — the single enum
 * cannot, which is why that field exists.
 */
export function obtainedVia(kinds: readonly SourceKind[]): 'plaid' | 'db' {
  return kinds.length > 0 && !kinds.includes('plaid') ? 'db' : 'plaid';
}
