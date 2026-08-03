/**
 * Postgres schema (§3).
 *
 * What is NOT here is the point: no balances, no holdings, no securities, no
 * transaction ledger. Plaid is the system of record for all of those and they
 * live only in a request-scoped in-memory snapshot (§0.4, §7). The tables below
 * hold tokens, the user's own context, PII-free audit, and derived aggregates.
 *
 * Every money column is BIGINT cents (§0.3) — never numeric, never float.
 */

import { relations } from 'drizzle-orm';
import {
  bigint,
  date,
  index,
  jsonb,
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

export const usersRelations = relations(users, ({ many, one }) => ({
  items: many(plaidItems),
  accounts: many(linkedAccounts),
  goals: many(goals),
  profile: one(userProfile, { fields: [users.id], references: [userProfile.userId] }),
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
