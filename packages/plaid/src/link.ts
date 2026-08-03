/**
 * Item linking (§7.1): public_token → access_token → encrypted at rest.
 *
 * The access token never leaves this file in plaintext beyond the insert, and
 * is never logged. Bank credentials are never seen at all — Plaid Link handles
 * those entirely on its own side.
 */

import { type Database, encryptToken, linkedAccounts, plaidItems } from '@pfg/db';
import { CountryCode, type PlaidApi, Products } from 'plaid';
import { createPlaidClient } from './client.js';

const DEFAULT_PRODUCTS = [Products.Transactions, Products.Investments];
const DEFAULT_COUNTRIES = [CountryCode.Us];

export interface CreateLinkTokenOptions {
  userId: string;
  plaid?: PlaidApi;
  clientName?: string;
}

export async function createLinkToken(options: CreateLinkTokenOptions): Promise<string> {
  const { userId, plaid = createPlaidClient(), clientName = 'Personal Finance Guru' } = options;
  const response = await plaid.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: clientName,
    products: DEFAULT_PRODUCTS,
    country_codes: DEFAULT_COUNTRIES,
    language: 'en',
  });
  return response.data.link_token;
}

export interface ExchangePublicTokenOptions {
  userId: string;
  db: Database;
  publicToken: string;
  plaid?: PlaidApi;
  /**
   * Populate the minimal `linked_accounts` registry so the UI can list
   * connections without a live Plaid call. Names and masks only — no balances.
   */
  registerAccounts?: boolean;
}

export interface LinkedItemSummary {
  itemRowId: string;
  plaidItemId: string;
  institutionName: string | null;
  accountCount: number;
}

export async function exchangePublicToken(
  options: ExchangePublicTokenOptions,
): Promise<LinkedItemSummary> {
  const { userId, db, publicToken, plaid = createPlaidClient(), registerAccounts = true } = options;

  const exchange = await plaid.itemPublicTokenExchange({ public_token: publicToken });
  const accessToken = exchange.data.access_token;
  const plaidItemId = exchange.data.item_id;

  const itemResponse = await plaid.itemGet({ access_token: accessToken });
  const institutionId = itemResponse.data.item.institution_id ?? null;

  let institutionName: string | null = null;
  if (institutionId) {
    try {
      const institution = await plaid.institutionsGetById({
        institution_id: institutionId,
        country_codes: DEFAULT_COUNTRIES,
      });
      institutionName = institution.data.institution.name;
    } catch {
      // A missing display name is cosmetic — never fail a link over it.
      institutionName = null;
    }
  }

  const [row] = await db
    .insert(plaidItems)
    .values({
      userId,
      plaidItemId,
      accessTokenEncrypted: encryptToken(accessToken),
      institutionId,
      institutionName,
      status: 'active',
    })
    .onConflictDoUpdate({
      target: plaidItems.plaidItemId,
      set: {
        accessTokenEncrypted: encryptToken(accessToken),
        institutionName,
        status: 'active',
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!row) throw new Error('exchangePublicToken: failed to persist the Plaid item.');

  let accountCount = 0;
  if (registerAccounts) {
    const accounts = await plaid.accountsGet({ access_token: accessToken });
    accountCount = accounts.data.accounts.length;
    if (accountCount > 0) {
      await db
        .insert(linkedAccounts)
        .values(
          accounts.data.accounts.map((a) => ({
            userId,
            itemId: row.id,
            plaidAccountId: a.account_id,
            name: a.name,
            mask: a.mask ?? null,
            type: String(a.type),
            subtype: a.subtype ? String(a.subtype) : null,
          })),
        )
        .onConflictDoNothing({ target: linkedAccounts.plaidAccountId });
    }
  }

  return { itemRowId: row.id, plaidItemId, institutionName, accountCount };
}

export interface CreateSandboxItemOptions {
  userId: string;
  db: Database;
  plaid?: PlaidApi;
  /** Plaid sandbox institution id. Defaults to First Platypus Bank. */
  institutionId?: string;
  products?: Products[];
}

/**
 * Sandbox-only shortcut that mints a public_token without any UI, so Checkpoint
 * 1 can be reached before the Plaid Link frontend exists (Phase 1).
 */
export async function createSandboxItem(
  options: CreateSandboxItemOptions,
): Promise<LinkedItemSummary> {
  const {
    userId,
    db,
    plaid = createPlaidClient(),
    institutionId = 'ins_109508',
    products = DEFAULT_PRODUCTS,
  } = options;

  if ((process.env.PLAID_ENV ?? 'sandbox') !== 'sandbox') {
    throw new Error('createSandboxItem only works against PLAID_ENV=sandbox.');
  }

  const sandbox = await plaid.sandboxPublicTokenCreate({
    institution_id: institutionId,
    initial_products: products,
  });

  return exchangePublicToken({ userId, db, publicToken: sandbox.data.public_token, plaid });
}
