/**
 * The Plaid connections a user has, and disconnecting one (Phase 2 /sources).
 *
 * Listing reads Postgres only — the registry exists so "what is connected?"
 * costs no live call (§3). Disconnecting tells Plaid to revoke the item, then
 * deletes our encrypted token and account registry for it. Nothing financial
 * about the item exists here to delete: none of it was ever stored (§0.4).
 */

import type { TraceRecorder } from '@pfg/core';
import { type Database, decryptToken, plaidItems } from '@pfg/db';
import { and, asc, eq } from 'drizzle-orm';
import type { PlaidApi } from 'plaid';
import { createPlaidClient, describePlaidError } from './client.js';

export interface PlaidItemSummary {
  id: string;
  institutionName: string | null;
  /** active | login_required | revoked */
  status: string;
  createdAt: string;
}

export async function listPlaidItems(db: Database, userId: string): Promise<PlaidItemSummary[]> {
  const rows = await db
    .select({ id: plaidItems.id, institutionName: plaidItems.institutionName, status: plaidItems.status, createdAt: plaidItems.createdAt })
    .from(plaidItems)
    .where(eq(plaidItems.userId, userId))
    .orderBy(asc(plaidItems.createdAt));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export class PlaidItemNotFoundError extends Error {
  constructor() {
    super('No such connection.');
    this.name = 'PlaidItemNotFoundError';
  }
}

/**
 * Disconnect one item. If Plaid cannot be reached the local token is still
 * deleted — the user asked us to stop reading this bank, and without the token
 * we cannot — and the result says Plaid was not told, rather than hiding it.
 */
export async function disconnectPlaidItem(options: {
  db: Database;
  userId: string;
  itemRowId: string;
  plaid?: PlaidApi;
  trace?: TraceRecorder;
}): Promise<{ institutionName: string | null; plaidNotified: boolean; reason?: string }> {
  const { db, userId, itemRowId } = options;
  const [item] = await db
    .select()
    .from(plaidItems)
    .where(and(eq(plaidItems.id, itemRowId), eq(plaidItems.userId, userId)));
  if (!item) throw new PlaidItemNotFoundError();

  let plaidNotified = true;
  let reason: string | undefined;
  try {
    const plaid = options.plaid ?? createPlaidClient();
    const call = () => plaid.itemRemove({ access_token: decryptToken(item.accessTokenEncrypted) });
    await (options.trace ? options.trace.track('plaid', '/item/remove', call, () => ({ detail: item.institutionName ?? undefined })) : call());
  } catch (error) {
    plaidNotified = false;
    reason = describePlaidError(error).message;
  }

  // Cascades to linked_accounts. The encrypted token goes with the row.
  await db.delete(plaidItems).where(and(eq(plaidItems.id, item.id), eq(plaidItems.userId, userId)));
  return { institutionName: item.institutionName, plaidNotified, ...(reason ? { reason } : {}) };
}
