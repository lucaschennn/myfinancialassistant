/**
 * The dollars→cents boundary (§0.3). Plaid speaks in JS floats; everything past
 * this file speaks in integer cents. Nothing else in the codebase is allowed to
 * call `dollarsToCents`.
 */

import {
  type AccountType,
  type SnapshotAccount,
  type SnapshotHolding,
  type SnapshotSecurity,
  type SnapshotTransaction,
  dollarsToCents,
  dollarsToCentsOrNull,
} from '@pfg/core';
import type {
  AccountBase,
  Holding,
  Security,
  Transaction as PlaidTransaction,
} from 'plaid';

const KNOWN_ACCOUNT_TYPES = new Set<AccountType>([
  'depository',
  'investment',
  'credit',
  'loan',
  'brokerage',
  'other',
]);

/**
 * Plaid can introduce new account types. An unrecognised one falls back to
 * `other`, which means it counts toward net worth as an asset but not toward
 * investable assets — the conservative direction for a value we cannot classify.
 */
function toAccountType(raw: string): AccountType {
  return KNOWN_ACCOUNT_TYPES.has(raw as AccountType) ? (raw as AccountType) : 'other';
}

export interface AccountContext {
  itemId: string;
  institutionName: string | null;
}

export function normalizeAccount(account: AccountBase, ctx: AccountContext): SnapshotAccount {
  return {
    accountId: account.account_id,
    itemId: ctx.itemId,
    institutionName: ctx.institutionName,
    name: account.name,
    officialName: account.official_name ?? null,
    mask: account.mask ?? null,
    type: toAccountType(String(account.type)),
    subtype: account.subtype ? String(account.subtype) : null,
    currentCents: dollarsToCentsOrNull(account.balances.current),
    availableCents: dollarsToCentsOrNull(account.balances.available),
    limitCents: dollarsToCentsOrNull(account.balances.limit),
    isoCurrencyCode: account.balances.iso_currency_code ?? null,
  };
}

export function normalizeSecurity(security: Security): SnapshotSecurity {
  return {
    securityId: security.security_id,
    name: security.name ?? null,
    tickerSymbol: security.ticker_symbol ?? null,
    type: security.type ?? null,
    closePriceCents: dollarsToCentsOrNull(security.close_price),
    isCashEquivalent: security.is_cash_equivalent ?? false,
  };
}

export function normalizeHolding(holding: Holding): SnapshotHolding {
  return {
    accountId: holding.account_id,
    securityId: holding.security_id,
    quantity: holding.quantity,
    costBasisCents: dollarsToCentsOrNull(holding.cost_basis),
    valueCents: dollarsToCents(holding.institution_value),
    isoCurrencyCode: holding.iso_currency_code ?? null,
  };
}

export function normalizeTransaction(transaction: PlaidTransaction): SnapshotTransaction {
  const pfc = transaction.personal_finance_category;
  return {
    transactionId: transaction.transaction_id,
    accountId: transaction.account_id,
    date: transaction.date,
    // Plaid's sign is preserved deliberately (positive = money out). See the
    // note on SnapshotTransaction.amountCents.
    amountCents: dollarsToCents(transaction.amount),
    name: transaction.name,
    merchantName: transaction.merchant_name ?? null,
    pending: transaction.pending ?? false,
    category: pfc ? { primary: pfc.primary, detailed: pfc.detailed } : null,
    isoCurrencyCode: transaction.iso_currency_code ?? null,
  };
}
