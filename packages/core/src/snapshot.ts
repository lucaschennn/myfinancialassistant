/**
 * The session snapshot (§7): Plaid's financial data, held in memory for the
 * life of one request and then discarded. Nothing in this file is ever written
 * to Postgres — that is the whole point of the data-minimisation stance (§0.4).
 *
 * On Vercel the "session" is a single chat turn: each turn refetches. Under the
 * MCP dev harness the process is long-lived, so one snapshot can genuinely span
 * many tool calls.
 */

import type { Cents } from './money.js';

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
}

export interface SnapshotSecurity {
  securityId: string;
  name: string | null;
  tickerSymbol: string | null;
  /** Plaid: cash | cryptocurrency | derivative | equity | etf | fixed income | loan | mutual fund | other */
  type: string | null;
  closePriceCents: Cents | null;
  isCashEquivalent: boolean;
}

export interface SnapshotHolding {
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
  itemId: string;
  institutionName: string | null;
  /** Which dataset is missing. */
  dataset: 'balances' | 'holdings' | 'transactions';
  reason: string;
  /** Plaid error code, when the failure came back structured. */
  plaidErrorCode?: string;
}

export interface SessionSnapshot {
  /** Whose data this is. Every tool asserts this matches `ctx.userId` (§3). */
  userId: string;
  /** ISO 8601 — when the live fetch ran. Becomes `provenance.asOf`. */
  fetchedAt: string;
  accounts: SnapshotAccount[];
  holdings: SnapshotHolding[];
  securities: SnapshotSecurity[];
  transactions: SnapshotTransaction[];
  /** The window `/transactions/get` was asked for, so gaps are legible. */
  transactionWindow: { from: string; to: string } | null;
  gaps: SnapshotGap[];
}

export function emptySnapshot(userId: string): SessionSnapshot {
  return {
    userId,
    fetchedAt: new Date().toISOString(),
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
