/**
 * Fixture builders for the compute test suite (§4). Amounts are given in
 * dollars for readability and converted at the boundary, exactly as the Plaid
 * normaliser does — so the tests exercise the same cents conversion the real
 * pipeline uses.
 */

import { dollarsToCents } from '../money.js';
import type {
  AccountType,
  SessionSnapshot,
  SnapshotAccount,
  SnapshotGap,
  SnapshotHolding,
  SnapshotSecurity,
  SnapshotTransaction,
  SourceKind,
} from '../snapshot.js';
import { sourcesOf } from '../snapshot.js';

export const TEST_USER_ID = '00000000-0000-4000-8000-000000000001';
export const TEST_FETCHED_AT = '2026-08-01T12:00:00.000Z';

let counter = 0;
const nextId = (prefix: string): string => `${prefix}_${(counter += 1)}`;

export interface AccountSpec {
  id?: string;
  name?: string;
  type: AccountType;
  subtype?: string;
  /** Dollars. For liability accounts this is the amount owed, as Plaid reports it. */
  current: number | null;
  institution?: string;
  mask?: string;
  /** Defaults to 'plaid'. */
  source?: SourceKind;
  /** ISO date or timestamp the balance was true. Defaults to the fixture fetch time. */
  balanceAsOf?: string;
}

export function account(spec: AccountSpec): SnapshotAccount {
  const source = spec.source ?? 'plaid';
  return {
    source,
    accountId: spec.id ?? nextId(source === 'manual' ? 'manual_acct' : 'acct'),
    itemId: source === 'manual' ? 'manual' : 'item_test',
    institutionName: spec.institution ?? 'Test Bank',
    name: spec.name ?? `${spec.type} account`,
    officialName: null,
    mask: spec.mask ?? '0000',
    type: spec.type,
    subtype: spec.subtype ?? null,
    currentCents: spec.current === null ? null : dollarsToCents(spec.current),
    availableCents: null,
    limitCents: null,
    isoCurrencyCode: 'USD',
    balanceAsOf: spec.balanceAsOf ?? TEST_FETCHED_AT,
  };
}

export interface SecuritySpec {
  id?: string;
  name?: string;
  ticker?: string;
  type: string | null;
  isCashEquivalent?: boolean;
  source?: SourceKind;
}

export function security(spec: SecuritySpec): SnapshotSecurity {
  return {
    source: spec.source ?? 'plaid',
    securityId: spec.id ?? nextId('sec'),
    name: spec.name ?? spec.ticker ?? 'Test Security',
    tickerSymbol: spec.ticker ?? null,
    type: spec.type,
    closePriceCents: null,
    isCashEquivalent: spec.isCashEquivalent ?? false,
  };
}

export interface HoldingSpec {
  accountId: string;
  securityId: string;
  /** Dollars. */
  value: number;
  quantity?: number;
  source?: SourceKind;
}

export function holding(spec: HoldingSpec): SnapshotHolding {
  return {
    source: spec.source ?? 'plaid',
    accountId: spec.accountId,
    securityId: spec.securityId,
    quantity: spec.quantity ?? 1,
    costBasisCents: null,
    valueCents: dollarsToCents(spec.value),
    isoCurrencyCode: 'USD',
  };
}

export interface TransactionSpec {
  accountId?: string;
  date: string;
  /** Dollars, PLAID SIGN: positive = money out, negative = money in. */
  amount: number;
  name?: string;
  primary?: string;
  detailed?: string;
  pending?: boolean;
  source?: SourceKind;
}

export function transaction(spec: TransactionSpec): SnapshotTransaction {
  return {
    source: spec.source ?? 'plaid',
    transactionId: nextId('txn'),
    accountId: spec.accountId ?? 'acct_checking',
    date: spec.date,
    amountCents: dollarsToCents(spec.amount),
    name: spec.name ?? 'Test transaction',
    merchantName: null,
    pending: spec.pending ?? false,
    category: spec.primary
      ? { primary: spec.primary, detailed: spec.detailed ?? `${spec.primary}_OTHER` }
      : null,
    isoCurrencyCode: 'USD',
  };
}

export interface SnapshotSpec {
  userId?: string;
  accounts?: SnapshotAccount[];
  holdings?: SnapshotHolding[];
  securities?: SnapshotSecurity[];
  transactions?: SnapshotTransaction[];
  transactionWindow?: { from: string; to: string } | null;
  gaps?: SnapshotGap[];
  fetchedAt?: string;
  /** Defaults to the kinds present among `accounts`. */
  sources?: SourceKind[];
}

export function snapshot(spec: SnapshotSpec = {}): SessionSnapshot {
  return {
    userId: spec.userId ?? TEST_USER_ID,
    fetchedAt: spec.fetchedAt ?? TEST_FETCHED_AT,
    sources: spec.sources ?? sourcesOf(spec.accounts ?? []),
    accounts: spec.accounts ?? [],
    holdings: spec.holdings ?? [],
    securities: spec.securities ?? [],
    transactions: spec.transactions ?? [],
    transactionWindow:
      spec.transactionWindow === undefined
        ? { from: '2026-05-03', to: '2026-08-01' }
        : spec.transactionWindow,
    gaps: spec.gaps ?? [],
  };
}

/** A household with cash, investments, a card, and a mortgage. */
export function typicalSnapshot(): SessionSnapshot {
  const checking = account({
    id: 'acct_checking',
    name: 'Everyday Checking',
    type: 'depository',
    subtype: 'checking',
    current: 4_250.75,
  });
  const savings = account({
    id: 'acct_savings',
    name: 'Emergency Savings',
    type: 'depository',
    subtype: 'savings',
    current: 18_000,
  });
  const brokerage = account({
    id: 'acct_brokerage',
    name: 'Brokerage',
    type: 'investment',
    subtype: 'brokerage',
    current: 152_300.4,
  });
  const card = account({
    id: 'acct_card',
    name: 'Rewards Card',
    type: 'credit',
    subtype: 'credit card',
    current: 2_310.2,
  });
  const mortgage = account({
    id: 'acct_mortgage',
    name: 'Mortgage',
    type: 'loan',
    subtype: 'mortgage',
    current: 310_000,
  });
  const house = account({
    id: 'acct_house',
    name: 'Primary Residence',
    type: 'other',
    subtype: 'other',
    current: 520_000,
  });

  const vti = security({ id: 'sec_vti', ticker: 'VTI', type: 'etf' });
  const aapl = security({ id: 'sec_aapl', ticker: 'AAPL', type: 'equity' });
  const bnd = security({ id: 'sec_bnd', ticker: 'BND', type: 'fixed income' });
  const sweep = security({ id: 'sec_cash', name: 'Cash Sweep', type: 'cash', isCashEquivalent: true });

  return snapshot({
    accounts: [checking, savings, brokerage, card, mortgage, house],
    securities: [vti, aapl, bnd, sweep],
    holdings: [
      holding({ accountId: 'acct_brokerage', securityId: 'sec_vti', value: 90_000 }),
      holding({ accountId: 'acct_brokerage', securityId: 'sec_aapl', value: 40_000 }),
      holding({ accountId: 'acct_brokerage', securityId: 'sec_bnd', value: 20_000 }),
      holding({ accountId: 'acct_brokerage', securityId: 'sec_cash', value: 2_300.4 }),
    ],
    transactions: [
      transaction({ date: '2026-07-01', amount: -6_500, primary: 'INCOME', detailed: 'INCOME_WAGES', name: 'Payroll' }),
      transaction({ date: '2026-07-15', amount: -6_500, primary: 'INCOME', detailed: 'INCOME_WAGES', name: 'Payroll' }),
      transaction({ date: '2026-07-03', amount: 2_100, primary: 'RENT_AND_UTILITIES', detailed: 'RENT_AND_UTILITIES_RENT' }),
      transaction({ date: '2026-07-05', amount: 420.5, primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' }),
      transaction({ date: '2026-07-12', amount: 96.25, primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_RESTAURANT' }),
      transaction({ date: '2026-07-18', amount: 310, primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_GAS' }),
      transaction({ date: '2026-07-20', amount: 1_500, primary: 'TRANSFER_OUT', detailed: 'TRANSFER_OUT_INVESTMENT' }),
      transaction({ date: '2026-07-22', amount: 89.99, primary: 'ENTERTAINMENT', detailed: 'ENTERTAINMENT_STREAMING', pending: true }),
    ],
  });
}
