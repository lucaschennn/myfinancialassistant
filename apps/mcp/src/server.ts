/**
 * Thin MCP wrapper (§1, §2) — the Checkpoint 0 test harness.
 *
 * "Thin" is the contract: every tool here is a one-line delegation to `@pfg/core`.
 * No computation, no reshaping of figures, no business logic. If logic ever
 * needs to live somewhere, it belongs in `core` so the app path gets it too
 * (§0.5, one implementation, two front doors).
 *
 * This exposes the ATOMIC tools, not the workflow pipelines. Claude Code drives
 * the ordering itself in this path, which is fine for interactive testing but
 * means it does NOT exercise the fixed pipeline (§1) — that is validated
 * separately by `summaryOverview.test.ts` and `scripts/checkpoint0-summary.ts`.
 *
 * Local dev only. Never deployed.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  addNote,
  assetAllocation,
  cashFlow,
  fireProgress,
  getBalances,
  getHoldings,
  getNetWorthHistory,
  getTransactions,
  getUserContext,
  humanize,
  listAccounts,
  netWorth,
  runWorkflow,
  savingsRate,
  setGoal,
  setProfile,
  spendingByCategory,
  toJson,
  type WorkflowName,
  type WorkflowParams,
} from '@pfg/core';
import { closeDb, loadEnv } from '@pfg/db';
import { MisconfiguredHarnessError, Session, loadHarnessConfig } from './session.js';

// Claude Code launches this server with an arbitrary working directory, so the
// .env lookup must be anchored to the repo, not to cwd.
loadEnv();

/**
 * Config is loaded before anything else so a misconfigured harness fails with a
 * one-line instruction on stderr rather than a stack trace — this is the first
 * thing a person sees when wiring up Checkpoint 0.
 */
function loadOrExit(): ReturnType<typeof loadHarnessConfig> {
  try {
    return loadHarnessConfig();
  } catch (error) {
    if (error instanceof MisconfiguredHarnessError) {
      console.error(`[pfg-mcp] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

const config = loadOrExit();
const session = new Session(config);

const server = new McpServer({ name: 'personal-finance-guru', version: '0.1.0' });

/** Every tool answers with `{ data, provenance }`, JSON-encoded (§0.2). */
function reply(payload: unknown) {
  return { content: [{ type: 'text' as const, text: toJson(humanize(payload), 2) }] };
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

/** Wrap a handler so a thrown error becomes a readable tool result, not a crash. */
function handler<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return reply(await fn(args));
    } catch (error) {
      return fail(error);
    }
  };
}

const accountIds = z
  .array(z.string())
  .optional()
  .describe('Plaid account ids to restrict to. Omit for all accounts.');

const period = {
  from: z.string().describe('Inclusive start date, YYYY-MM-DD.'),
  to: z.string().describe('Inclusive end date, YYYY-MM-DD.'),
};

const selectOptions = {
  excludeTransfers: z
    .boolean()
    .optional()
    .describe('Default true. Transfers between the user\'s own accounts are excluded.'),
  includePending: z.boolean().optional().describe('Default false.'),
};

/** Cents are the wire format; the model must not convert dollars itself (§0.3). */
const cents = (description: string) => z.union([z.number().int(), z.string()]).describe(description);

function toCents(value: number | string | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  return BigInt(value);
}

// --- Session ----------------------------------------------------------------

server.registerTool(
  'sessionStatus',
  {
    title: 'Session status',
    description:
      'Show which sandbox user this harness is bound to and whether a live Plaid snapshot ' +
      'is currently held in memory.',
    inputSchema: {},
  },
  handler(async () => session.status()),
);

server.registerTool(
  'refreshSnapshot',
  {
    title: 'Refresh snapshot',
    description:
      'Force a fresh live fetch of balances, holdings, and transactions from Plaid. Other ' +
      'tools fetch automatically when needed; use this to pick up sandbox changes.',
    inputSchema: {},
  },
  handler(async () => {
    const snapshot = await session.getSnapshot(true);
    return {
      data: {
        fetchedAt: snapshot.fetchedAt,
        accountCount: snapshot.accounts.length,
        holdingCount: snapshot.holdings.length,
        transactionCount: snapshot.transactions.length,
        transactionWindow: snapshot.transactionWindow,
        gaps: snapshot.gaps,
      },
      provenance: { source: 'plaid', asOf: snapshot.fetchedAt },
    };
  }),
);

server.registerTool(
  'endSession',
  {
    title: 'End session',
    description: 'Discard the in-memory snapshot (§7 session end). Nothing financial is persisted.',
    inputSchema: {},
  },
  handler(async () => {
    session.clear();
    return { data: { cleared: true }, provenance: { source: 'compute', asOf: new Date().toISOString() } };
  }),
);

// --- Aggregation ------------------------------------------------------------

server.registerTool(
  'listAccounts',
  {
    title: 'List accounts',
    description: 'Every connected account, with no balances attached.',
    inputSchema: {},
  },
  handler(async () => listAccounts(await session.ctx())),
);

server.registerTool(
  'getBalances',
  {
    title: 'Get balances',
    description:
      'Current, available, and limit balances per account. Liability balances are POSITIVE ' +
      'amounts owed — do not negate them yourself; netWorth handles that.',
    inputSchema: { accountIds },
  },
  handler(async (args: { accountIds?: string[] }) =>
    getBalances(await session.ctx(), args.accountIds ? { accountIds: args.accountIds } : {}),
  ),
);

server.registerTool(
  'getHoldings',
  {
    title: 'Get holdings',
    description: 'Investment positions and the securities they reference.',
    inputSchema: { accountIds },
  },
  handler(async (args: { accountIds?: string[] }) =>
    getHoldings(await session.ctx(), args.accountIds ? { accountIds: args.accountIds } : {}),
  ),
);

server.registerTool(
  'getTransactions',
  {
    title: 'Get transactions',
    description:
      'Transactions in an explicit date range. Positive amounts are money LEAVING the ' +
      'account. Dates must be concrete — resolve "last month" before calling.',
    inputSchema: {
      ...period,
      accountIds,
      categories: z
        .array(z.string())
        .optional()
        .describe('Plaid personal_finance_category primary values, e.g. FOOD_AND_DRINK.'),
      ...selectOptions,
    },
  },
  handler(async (args: Parameters<typeof getTransactions>[1]) =>
    getTransactions(await session.ctx(), args),
  ),
);

// --- Compute ----------------------------------------------------------------

server.registerTool(
  'netWorth',
  {
    title: 'Net worth',
    description:
      'Assets minus liabilities across ALL account types, including illiquid ones like ' +
      'property. This is the only correct source for a net worth figure.',
    inputSchema: {},
  },
  handler(async () => netWorth(await session.ctx())),
);

server.registerTool(
  'assetAllocation',
  {
    title: 'Asset allocation',
    description:
      'Investment holdings grouped into asset classes. Covers securities in investment ' +
      'accounts only — cash in checking/savings is not included.',
    inputSchema: { accountIds },
  },
  handler(async (args: { accountIds?: string[] }) =>
    assetAllocation(await session.ctx(), args.accountIds ? { accountIds: args.accountIds } : {}),
  ),
);

server.registerTool(
  'fireProgress',
  {
    title: 'FIRE progress',
    description:
      'Progress toward financial independence. Uses INVESTABLE net worth — investment and ' +
      'cash accounts, minus debts other than housing — which is a different figure from ' +
      'netWorth: a house cannot fund withdrawals, and its mortgage is already reflected in ' +
      'the annual spending target. Falls back to the saved profile target when ' +
      'annualSpendCents is omitted.',
    inputSchema: {
      annualSpendCents: cents('Annual spending target in CENTS. 60000 dollars = 6000000.').optional(),
      multiple: z.number().optional().describe('Target = spend x multiple. Default 25.'),
      withdrawalRate: z
        .number()
        .optional()
        .describe('Fraction, not percent: 0.04 for the 4% rule. Overrides multiple.'),
    },
  },
  handler(async (args: { annualSpendCents?: number | string; multiple?: number; withdrawalRate?: number }) => {
    const spend = toCents(args.annualSpendCents);
    return fireProgress(await session.ctx(), {
      ...(spend !== undefined ? { annualSpendCents: spend } : {}),
      ...(args.multiple !== undefined ? { multiple: args.multiple } : {}),
      ...(args.withdrawalRate !== undefined ? { withdrawalRate: args.withdrawalRate } : {}),
    });
  }),
);

server.registerTool(
  'cashFlow',
  {
    title: 'Cash flow',
    description: 'Money in and money out over an explicit date range, as positive magnitudes.',
    inputSchema: { ...period, accountIds, ...selectOptions },
  },
  handler(async (args: { from: string; to: string; accountIds?: string[]; excludeTransfers?: boolean; includePending?: boolean }) => {
    const { from, to, ...rest } = args;
    return cashFlow(await session.ctx(), { period: { from, to }, ...rest });
  }),
);

server.registerTool(
  'savingsRate',
  {
    title: 'Savings rate',
    description: '(income − spend) ÷ income over an explicit date range. Can be negative.',
    inputSchema: { ...period, accountIds, ...selectOptions },
  },
  handler(async (args: { from: string; to: string; accountIds?: string[]; excludeTransfers?: boolean; includePending?: boolean }) => {
    const { from, to, ...rest } = args;
    return savingsRate(await session.ctx(), { period: { from, to }, ...rest });
  }),
);

server.registerTool(
  'spendingByCategory',
  {
    title: 'Spending by category',
    description:
      "Outflows grouped by Plaid's personal_finance_category over an explicit date range.",
    inputSchema: { ...period, accountIds, ...selectOptions },
  },
  handler(async (args: { from: string; to: string; accountIds?: string[]; excludeTransfers?: boolean; includePending?: boolean }) => {
    const { from, to, ...rest } = args;
    return spendingByCategory(await session.ctx(), { period: { from, to }, ...rest });
  }),
);

// --- Workflows --------------------------------------------------------------
// The one tool here that is NOT atomic. Everything above exposes a single core
// function; this runs a fixed pipeline of them (§5) and returns the whole
// evidence bundle.
//
// It exists for interactive testing convenience, and it is deliberately the
// only pipeline entry point — one tool taking a workflow name, rather than one
// tool per workflow, so the set of pipelines stays defined in `core` and cannot
// drift here.

server.registerTool(
  'runWorkflow',
  {
    title: 'Run a workflow pipeline',
    description:
      'Run a fixed tool pipeline end to end and return its evidence bundle — the same code ' +
      'path the deployed app uses. Unlike the atomic tools above, the tool sequence is ' +
      'chosen by the workflow, not by you. Note this does NOT independently validate the ' +
      'atomic tools: calling them yourself in some order exercises a different property. ' +
      'All six §5 workflows are registered.',
    inputSchema: {
      workflow: z
        .enum([
          'summary_overview',
          'spending_analysis',
          'investment_review',
          'goal_progress',
          'transaction_lookup',
          'general_qa',
        ])
        .describe('Which pipeline to run.'),
      from: z.string().optional().describe('Period start, YYYY-MM-DD. For period-scoped workflows.'),
      to: z.string().optional().describe('Period end, YYYY-MM-DD.'),
      accountIds,
      annualSpendCents: cents('Overrides the profile target, in CENTS.').optional(),
      multiple: z.number().optional().describe('FIRE multiple. Default 25.'),
      withdrawalRate: z.number().optional().describe('Fraction, e.g. 0.04. Overrides multiple.'),
    },
  },
  handler(
    async (args: {
      workflow: WorkflowName;
      from?: string;
      to?: string;
      accountIds?: string[];
      annualSpendCents?: number | string;
      multiple?: number;
      withdrawalRate?: number;
    }) => {
      const spend = toCents(args.annualSpendCents);
      const params: WorkflowParams = {
        ...(args.from && args.to ? { period: { from: args.from, to: args.to } } : {}),
        ...(args.accountIds ? { accountIds: args.accountIds } : {}),
        ...(spend !== undefined ? { annualSpendCents: spend } : {}),
        ...(args.multiple !== undefined ? { multiple: args.multiple } : {}),
        ...(args.withdrawalRate !== undefined ? { withdrawalRate: args.withdrawalRate } : {}),
      };

      const { bundle, limitations } = await runWorkflow(args.workflow, await session.ctx(), params);

      return {
        data: {
          workflow: bundle.workflow,
          pipeline: bundle.entries.map((e) => e.tool),
          entries: bundle.entries,
          limitations,
        },
        // The bundle's entries each carry their own provenance; this describes
        // the run itself rather than any single figure.
        provenance: {
          source: 'compute' as const,
          asOf: bundle.generatedAt,
          computation: `Fixed ${bundle.workflow} pipeline: ${bundle.entries
            .map((e) => e.tool)
            .join(' → ')}.`,
        },
      };
    },
  ),
);

// --- User context (Postgres — no Plaid fetch triggered) ---------------------

server.registerTool(
  'getUserContext',
  {
    title: 'Get user context',
    description: 'The profile, goals, and notes this user has entered. Not Plaid-derived.',
    inputSchema: {},
  },
  handler(async () => getUserContext(session.dbCtx())),
);

server.registerTool(
  'setProfile',
  {
    title: 'Set profile',
    description:
      'Update income, spending target, or risk tolerance. Omitted fields are left unchanged. ' +
      'Amounts are in CENTS.',
    inputSchema: {
      annualIncomeCents: cents('Annual income in cents.').optional(),
      targetAnnualSpendCents: cents('Target annual spend in cents. Feeds fireProgress.').optional(),
      riskTolerance: z.enum(['conservative', 'moderate', 'aggressive']).optional(),
    },
  },
  handler(async (args: { annualIncomeCents?: number | string; targetAnnualSpendCents?: number | string; riskTolerance?: string }) => {
    const params: Record<string, unknown> = {};
    if (args.annualIncomeCents !== undefined) params.annualIncomeCents = toCents(args.annualIncomeCents);
    if (args.targetAnnualSpendCents !== undefined) {
      params.targetAnnualSpendCents = toCents(args.targetAnnualSpendCents);
    }
    if (args.riskTolerance !== undefined) params.riskTolerance = args.riskTolerance;
    return setProfile(session.dbCtx(), params);
  }),
);

server.registerTool(
  'setGoal',
  {
    title: 'Set goal',
    description: 'Record a financial goal.',
    inputSchema: {
      type: z.enum(['fire', 'emergency_fund', 'debt_payoff', 'savings_target', 'custom']),
      label: z.string().optional(),
      targetCents: cents('Target amount in cents.').optional(),
      targetDate: z.string().optional().describe('YYYY-MM-DD'),
    },
  },
  handler(async (args: { type: string; label?: string; targetCents?: number | string; targetDate?: string }) => {
    const target = toCents(args.targetCents);
    return setGoal(session.dbCtx(), {
      type: args.type,
      ...(args.label !== undefined ? { label: args.label } : {}),
      ...(target !== undefined ? { targetCents: target } : {}),
      ...(args.targetDate !== undefined ? { targetDate: args.targetDate } : {}),
    });
  }),
);

server.registerTool(
  'addNote',
  {
    title: 'Add note',
    description: 'Save a free-form note about this user\'s situation.',
    inputSchema: { note: z.string().describe('The note text.') },
  },
  handler(async (args: { note: string }) => addNote(session.dbCtx(), args.note)),
);

server.registerTool(
  'getNetWorthHistory',
  {
    title: 'Net worth history',
    description:
      'Stored net worth snapshots over time — the one financial time series that persists, ' +
      'because it is a derived aggregate rather than raw Plaid data.',
    inputSchema: { limit: z.number().int().positive().optional() },
  },
  handler(async (args: { limit?: number }) =>
    getNetWorthHistory(session.dbCtx(), args.limit !== undefined ? { limit: args.limit } : {}),
  ),
);

// --- Boot -------------------------------------------------------------------

async function shutdown(): Promise<void> {
  session.clear();
  await closeDb().catch(() => undefined);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await server.connect(new StdioServerTransport());
// stdout carries the MCP protocol — all human output must go to stderr.
console.error(`[pfg-mcp] ready — user ${config.userId}, ${config.transactionDays}d transactions`);
