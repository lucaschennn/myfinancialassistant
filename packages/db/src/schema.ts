/**
 * Postgres schema (§3).
 *
 * What is NOT here is the point: no copy of Plaid's balances, holdings,
 * securities, or transactions. Plaid is the system of record for those and they
 * live only in a request-scoped in-memory snapshot (§0.4, §7). The tables below
 * hold tokens, the user's own context, PII-free audit, derived aggregates, and —
 * from Phase 2 — the manual ledger: financial data from the user's own documents,
 * stored because no external system holds it (§0.4's corollary). The `manual_*`
 * tables are the only durable financial data in the schema.
 *
 * Every money column is BIGINT cents (§0.3) — never numeric, never float.
 */

import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/** Clerk owns auth; this mirrors the minimum needed to scope rows. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Clerk user id. Null until Phase 1 wires Clerk — sandbox users are seeded directly. */
    authProviderId: text('auth_provider_id'),
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('users_auth_provider_id_unique').on(t.authProviderId)],
);

/**
 * A linked institution. `accessTokenEncrypted` is AES-256-GCM ciphertext (§9) —
 * the only field-level-encrypted column in the schema, because it is the one
 * value that grants access to everything else and is never computed over.
 *
 * No `transactions_cursor` column: with no persisted transaction store there is
 * nothing to incrementally sync against, so we use windowed /transactions/get.
 */
export const plaidItems = pgTable(
  'plaid_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    plaidItemId: text('plaid_item_id').notNull(),
    accessTokenEncrypted: text('access_token_encrypted').notNull(),
    institutionId: text('institution_id'),
    institutionName: text('institution_name'),
    /** active | login_required | revoked */
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('plaid_items_plaid_item_id_unique').on(t.plaidItemId),
    index('plaid_items_user_id_idx').on(t.userId),
  ],
);

/**
 * Minimal registry so the UI can list what is connected without a live Plaid
 * call. Deliberately holds NO balances or values — names and masks only.
 */
export const linkedAccounts = pgTable(
  'linked_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => plaidItems.id, { onDelete: 'cascade' }),
    plaidAccountId: text('plaid_account_id').notNull(),
    name: text('name'),
    nickname: text('nickname'),
    mask: text('mask'),
    type: text('type'),
    subtype: text('subtype'),
  },
  (t) => [
    unique('linked_accounts_plaid_account_id_unique').on(t.plaidAccountId),
    index('linked_accounts_user_id_idx').on(t.userId),
  ],
);

/** User-provided, not Plaid-derived. Feeds fireProgress's target. */
export const userProfile = pgTable('user_profile', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  annualIncomeCents: bigint('annual_income_cents', { mode: 'bigint' }),
  targetAnnualSpendCents: bigint('target_annual_spend_cents', { mode: 'bigint' }),
  /** conservative | moderate | aggressive */
  riskTolerance: text('risk_tolerance'),
  /** Free-form notes the user has added: Array<{ id, text, createdAt }>. */
  notesJson: jsonb('notes_json').$type<ProfileNote[]>().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export interface ProfileNote {
  id: string;
  text: string;
  createdAt: string;
}

export const goals = pgTable(
  'goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** fire | emergency_fund | debt_payoff | savings_target | custom */
    type: text('type').notNull(),
    label: text('label'),
    targetCents: bigint('target_cents', { mode: 'bigint' }),
    targetDate: date('target_date'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('goals_user_id_idx').on(t.userId)],
);

/**
 * Tier-1 derived aggregate (§3): a computed number, not a copy of Plaid data.
 * This is what makes net-worth-over-time possible without a transaction ledger.
 *
 * Sensitive in its own right — protected by DB encryption-at-rest plus
 * application-level user_id scoping, NOT field-level encryption, because we
 * need to aggregate and chart over these values.
 */
export const networthSnapshots = pgTable(
  'networth_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    asOfDate: date('as_of_date').notNull(),
    netWorthCents: bigint('net_worth_cents', { mode: 'bigint' }).notNull(),
    assetsCents: bigint('assets_cents', { mode: 'bigint' }).notNull(),
    liabilitiesCents: bigint('liabilities_cents', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per user per day: re-running a session the same day updates
    // rather than accumulating duplicate points on the chart.
    unique('networth_snapshots_user_date_unique').on(t.userId, t.asOfDate),
    index('networth_snapshots_user_id_idx').on(t.userId),
  ],
);

/** Tier-1 derived aggregate (§3), optional: computed rollups for trends. */
export const periodSummaries = pgTable(
  'period_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** ISO period key, e.g. 2026-07 or 2026-Q3. */
    period: text('period').notNull(),
    /** spend_by_category | savings_rate | cash_flow */
    metric: text('metric').notNull(),
    valueJson: jsonb('value_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('period_summaries_user_period_metric_unique').on(t.userId, t.period, t.metric),
    index('period_summaries_user_id_idx').on(t.userId),
  ],
);

/**
 * Transparency + eval trail (§5). Stores the REASONING trace only: workflow,
 * tool names, params, and provenance references. No financial values — evidence
 * is regenerated live when a user reopens a "why" card. Keeping figures out of
 * here is what lets the audit log exist without becoming a PII store.
 */
export const insightLog = pgTable(
  'insight_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workflow: text('workflow').notNull(),
    paramsJson: jsonb('params_json'),
    /** Array<{ tool, params, provenance }> — never `data`. */
    toolCallsJson: jsonb('tool_calls_json'),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('insight_log_user_id_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// Manual sources (Phase 2). Everything below is financial data the user handed
// over themselves. It is stored because there is nothing to refetch it from —
// the test in §0.4 — and every row is scoped by user_id and user-deletable.
// ---------------------------------------------------------------------------

/**
 * An artifact the user handed over: a CSV export, a PDF statement, or a typed
 * entry. The bytes are NOT here — they live encrypted in a DocumentStore (§9)
 * under `storageKey`. A `manual_entry` row has no bytes and exists so a typed
 * account has a provenance target like every other row.
 *
 * `draftJson` holds the parse proposal awaiting review. It contains financial
 * figures, so it is transient by design: cleared on commit or reject, because
 * past that point it is a duplicate of the ledger with no reader.
 */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** csv | pdf | manual_entry */
    kind: text('kind').notNull(),
    /** Display only. Attacker-controlled; NEVER a storage path (§9). */
    originalFilename: text('original_filename'),
    /** From a content sniff, not the extension. */
    mimeType: text('mime_type'),
    byteSize: integer('byte_size'),
    /** Null for manual_entry. Unique per user: the duplicate-statement guard. */
    sha256: text('sha256'),
    /** Opaque, server-generated: `${userId}/${uuid}`. Null for manual_entry. */
    storageKey: text('storage_key'),
    /** uploaded | parsed | needs_review | committed | failed | rejected */
    status: text('status').notNull().default('uploaded'),
    pageCount: integer('page_count'),
    /** Human-readable, e.g. "no text layer — this looks like a scanned image". */
    failureReason: text('failure_reason'),
    draftJson: jsonb('draft_json').$type<unknown>(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    committedAt: timestamp('committed_at', { withTimezone: true }),
  },
  (t) => [
    // NULLs are distinct in a Postgres unique constraint, so any number of
    // manual_entry rows (sha256 NULL) coexist while a re-uploaded file collides.
    unique('documents_user_sha256_unique').on(t.userId, t.sha256),
    index('documents_user_id_idx').on(t.userId),
  ],
);

/**
 * An account known only from the user's own records — the same shape the
 * snapshot needs. Archived rather than deleted, so balance rows never dangle;
 * the snapshot reads `archived_at IS NULL`. `type` is one of AccountType,
 * validated in core on write: the column is text, so the safety comes from there.
 */
export const manualAccounts = pgTable(
  'manual_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    officialName: text('official_name'),
    mask: text('mask'),
    type: text('type').notNull(),
    subtype: text('subtype'),
    institutionName: text('institution_name'),
    isoCurrencyCode: text('iso_currency_code').notNull().default('USD'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('manual_accounts_user_id_idx').on(t.userId)],
);

/**
 * A balance SERIES, one row per (account, date) — not a mutable column.
 * Statements are dated, net-worth history needs something honest to chart for a
 * manual user, and correcting a typo should not destroy the previous value.
 *
 * Liability balances are stored POSITIVE, the amount owed, exactly as Plaid
 * reports them. The sign flip happens in `netWorth` and nowhere else.
 */
export const manualBalances = pgTable(
  'manual_balances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => manualAccounts.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
    asOfDate: date('as_of_date').notNull(),
    currentCents: bigint('current_cents', { mode: 'bigint' }).notNull(),
    availableCents: bigint('available_cents', { mode: 'bigint' }),
    limitCents: bigint('limit_cents', { mode: 'bigint' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Re-importing a statement updates that date's balance, never adds a second.
    unique('manual_balances_account_date_unique').on(t.accountId, t.asOfDate),
    index('manual_balances_user_id_idx').on(t.userId),
  ],
);

/**
 * `amountCents` is in PLAID'S SIGN CONVENTION: positive = money leaving the
 * account. `cashFlow` and `savingsRate` interpret exactly that, so the importer
 * converts at the boundary and nothing past it knows a bank used another one.
 */
export const manualTransactions = pgTable(
  'manual_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => manualAccounts.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
    date: date('date').notNull(),
    amountCents: bigint('amount_cents', { mode: 'bigint' }).notNull(),
    name: text('name').notNull(),
    merchantName: text('merchant_name'),
    categoryPrimary: text('category_primary'),
    categoryDetailed: text('category_detailed'),
    externalId: text('external_id'),
    isoCurrencyCode: text('iso_currency_code').notNull().default('USD'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The practical dedupe key when a bank gives no transaction id, which is
    // usual. Two identical coffees on one day collapse to one — chosen over
    // double-counting overlapping statements, and reported as skipped on commit.
    unique('manual_transactions_dedupe_unique').on(t.accountId, t.date, t.amountCents, t.name),
    index('manual_transactions_user_date_idx').on(t.userId, t.date),
  ],
);

/** Securities known from the user's records. `type` uses Plaid's taxonomy verbatim (§10). */
export const manualSecurities = pgTable(
  'manual_securities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name'),
    tickerSymbol: text('ticker_symbol'),
    type: text('type'),
    closePriceCents: bigint('close_price_cents', { mode: 'bigint' }),
    isCashEquivalent: boolean('is_cash_equivalent').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('manual_securities_user_id_idx').on(t.userId)],
);

/**
 * A position on a date. `valueCents` is the institution-reported value and is
 * NEVER computed as quantity × price here — if the statement states a value,
 * that is the fact. `quantity` is the one non-cents number in the schema: a
 * share count, genuinely fractional, and not money.
 */
export const manualHoldings = pgTable(
  'manual_holdings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => manualAccounts.id, { onDelete: 'cascade' }),
    securityId: uuid('security_id')
      .notNull()
      .references(() => manualSecurities.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
    quantity: numeric('quantity', { mode: 'number' }).notNull(),
    costBasisCents: bigint('cost_basis_cents', { mode: 'bigint' }),
    valueCents: bigint('value_cents', { mode: 'bigint' }).notNull(),
    asOfDate: date('as_of_date').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('manual_holdings_account_security_date_unique').on(t.accountId, t.securityId, t.asOfDate),
    index('manual_holdings_user_id_idx').on(t.userId),
  ],
);

export const usersRelations = relations(users, ({ many, one }) => ({
  items: many(plaidItems),
  accounts: many(linkedAccounts),
  goals: many(goals),
  profile: one(userProfile, { fields: [users.id], references: [userProfile.userId] }),
}));

export const goalsRelations = relations(goals, ({ one }) => ({
  user: one(users, { fields: [goals.userId], references: [users.id] }),
}));

export const plaidItemsRelations = relations(plaidItems, ({ one, many }) => ({
  user: one(users, { fields: [plaidItems.userId], references: [users.id] }),
  accounts: many(linkedAccounts),
}));

export const linkedAccountsRelations = relations(linkedAccounts, ({ one }) => ({
  user: one(users, { fields: [linkedAccounts.userId], references: [users.id] }),
  item: one(plaidItems, { fields: [linkedAccounts.itemId], references: [plaidItems.id] }),
}));

export type User = typeof users.$inferSelect;
export type PlaidItem = typeof plaidItems.$inferSelect;
export type LinkedAccount = typeof linkedAccounts.$inferSelect;
export type UserProfile = typeof userProfile.$inferSelect;
export type Goal = typeof goals.$inferSelect;
export type NetworthSnapshot = typeof networthSnapshots.$inferSelect;
export type InsightLogRow = typeof insightLog.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type ManualAccount = typeof manualAccounts.$inferSelect;
export type ManualBalance = typeof manualBalances.$inferSelect;
export type ManualTransaction = typeof manualTransactions.$inferSelect;
export type ManualSecurity = typeof manualSecurities.$inferSelect;
export type ManualHolding = typeof manualHoldings.$inferSelect;
