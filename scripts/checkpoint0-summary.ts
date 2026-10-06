/**
 * Checkpoint 0, part 1 (§8): invoke the `summary_overview` workflow executor
 * DIRECTLY — not through MCP — against a live-fetched Plaid sandbox snapshot,
 * and print the resulting evidence bundle.
 *
 * Acceptance is: a correct, provenance-backed evidence bundle, with no
 * financial data persisted beyond the derived net worth snapshot.
 *
 *   npm run checkpoint0 -- --user <uuid>
 */

import {
  formatCents,
  humanize,
  mergeSources,
  runWorkflow,
  toJson,
  toReasoningTrace,
  transactionWindowFor,
} from '@pfg/core';
import { closeDb, getDb, loadEnv, users } from '@pfg/db';
import { readManualSource } from '@pfg/ingest';
import { fetchPlaidSource } from '@pfg/plaid';

loadEnv();

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

const db = getDb();
const verbose = argv.includes('--verbose');

try {
  let userId = flag('user') ?? process.env.MCP_DEV_USER_ID;

  // A non-UUID here would otherwise surface as an opaque Postgres 22P02 from
  // several frames deep inside the snapshot fetch.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (userId && !UUID.test(userId)) {
    throw new Error(
      `"${userId}" is not a users.id UUID (from --user or MCP_DEV_USER_ID). ` +
        'Run `npm run link:sandbox` and use the id it prints.',
    );
  }

  if (!userId) {
    const [first] = await db.select().from(users).limit(1);
    if (!first) throw new Error('No users exist. Run `npm run link:sandbox` first.');
    userId = first.id;
    console.log(`No --user given; using the only user in the database.`);
  }

  console.log(`\n=== Checkpoint 0: summary_overview for ${userId} ===\n`);

  // 1. Live fetch into an in-memory snapshot. Nothing here is written to disk.
  const started = Date.now();
  const now = new Date();
  const snapshot = mergeSources(
    userId,
    [
      await fetchPlaidSource({ userId, db, now }),
      await readManualSource({ userId, db, transactionWindow: transactionWindowFor(90, now) }),
    ],
    now,
  );
  console.log(`Live Plaid fetch: ${Date.now() - started}ms`);
  console.log(
    `  accounts ${snapshot.accounts.length} · holdings ${snapshot.holdings.length} · ` +
      `transactions ${snapshot.transactions.length}` +
      (snapshot.transactionWindow
        ? ` (${snapshot.transactionWindow.from} → ${snapshot.transactionWindow.to})`
        : ''),
  );
  if (snapshot.gaps.length > 0) {
    console.log('  gaps:');
    for (const gap of snapshot.gaps) {
      console.log(`    - ${gap.dataset} from ${gap.institutionName ?? gap.itemId}: ${gap.reason}`);
    }
  }

  // 2. Run the FIXED pipeline. The order is the workflow's, not a model's.
  const { bundle, limitations } = await runWorkflow('summary_overview', {
    userId,
    snapshot,
    db,
  });

  console.log(`\nPipeline: ${bundle.entries.map((e) => e.tool).join(' → ')}\n`);

  for (const entry of bundle.entries) {
    console.log(`── ${entry.tool}`);
    console.log(`   source: ${entry.provenance.source}   as of: ${entry.provenance.asOf}`);
    if (entry.provenance.computation) console.log(`   how:    ${entry.provenance.computation}`);
    for (const note of entry.provenance.notes ?? []) console.log(`   note:   ${note}`);

    const data = entry.data as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'bigint' && key.endsWith('Cents')) {
        console.log(`   ${key.replace(/Cents$/, '').padEnd(22)} ${formatCents(value)}`);
      }
    }
    console.log();
  }

  if (limitations.length > 0) {
    console.log('Limitations:');
    for (const limitation of limitations) console.log(`  - ${limitation}`);
    console.log();
  }

  // 3. Show what would be persisted to insight_log: the trace, with no figures.
  const trace = toReasoningTrace(bundle);
  console.log(`insight_log trace: ${trace.toolCalls.length} tool calls`);

  // The invariant that matters is structural, not textual: no money values
  // anywhere in what gets persisted. Grepping for digit runs (an earlier
  // version of this check) flags account masks and proves nothing either way.
  const moneyFindings: string[] = [];
  (function walk(value: unknown, path: string): void {
    if (typeof value === 'bigint') {
      moneyFindings.push(`${path} is a bigint`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key.endsWith('Cents')) moneyFindings.push(`${path}.${key}`);
        walk(child, `${path}.${key}`);
      }
    }
  })(trace, 'trace');

  console.log(
    moneyFindings.length === 0
      ? '  ✓ no financial figures present (§3: evidence is regenerated live, never stored)'
      : `  ✗ FINANCIAL FIGURES PRESENT: ${moneyFindings.join(', ')}`,
  );

  // Account names and masks do reach the trace via provenance notes. Not a
  // figure, and `linked_accounts` already stores masks by design (§3) — but
  // worth seeing before insight_log is wired up for real in Phase 2.
  const notes = trace.toolCalls.flatMap((c) => c.provenance.notes ?? []);
  const withMask = notes.filter((n) => /…\d{2,}/.test(n));
  console.log(`  ${notes.length} provenance note(s), ${withMask.length} naming an account mask`);

  if (verbose) {
    console.log('\n--- full evidence bundle ---');
    console.log(toJson(humanize(bundle), 2));
  } else {
    console.log('\nRe-run with --verbose for the full evidence bundle JSON.');
  }
} finally {
  await closeDb();
}
