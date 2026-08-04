/**
 * Live smoke test of the Phase 1 agent loop (§1), against the Plaid sandbox.
 *
 * This is the first time a model is actually in the loop, so it is the first
 * time §0.1 can be observed rather than asserted. The unit tests prove the
 * attribution guard identifies bad figures correctly; this proves the whole
 * path — route → fixed pipeline → synthesise → verify — holds up against a
 * real model and real (sandbox) data.
 *
 *   npm run agent:smoke                      run the default question set
 *   npm run agent:smoke -- "how am I doing"  ask one specific question
 *
 * Bypasses Clerk deliberately: it drives the sandbox user directly, so it can
 * run before auth keys exist.
 */

import { closeDb, getDb, loadEnv, users } from '@pfg/db';
import { fetchSnapshot } from '@pfg/plaid';
import { eq } from 'drizzle-orm';
import { runAgentTurn } from '../apps/web/src/server/agent.js';

loadEnv();

const argv = process.argv.slice(2);
const email = 'sandbox@example.test';

const QUESTIONS = argv.length > 0 ? argv : [
  'How am I doing overall?',
  'What do I actually own?',
  // Aimed squarely at §0.1: an invitation to do arithmetic the tools did not.
  'What is my net worth minus my mortgage?',
];

const db = getDb();

try {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    console.error(`No sandbox user (${email}). Run: npm run link:sandbox`);
    process.exit(1);
  }

  console.log(`Fetching live Plaid snapshot for ${user.id}…`);
  const snapshot = await fetchSnapshot({ userId: user.id, db, transactionDays: 90 });
  console.log(
    `  ${snapshot.accounts.length} accounts, ${snapshot.holdings.length} holdings, ` +
      `${snapshot.transactions.length} transactions, ${snapshot.gaps.length} gap(s)\n`,
  );

  const ctx = { userId: user.id, db, snapshot };
  let violations = 0;
  let retries = 0;

  for (const question of QUESTIONS) {
    console.log('─'.repeat(76));
    console.log(`Q: ${question}\n`);

    const started = Date.now();
    const result = await runAgentTurn(ctx, question);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    console.log(`A: ${result.answer}\n`);
    console.log(
      `   [${result.workflow} · routed by ${result.routedBy} · ` +
        `${result.bundle.entries.length} tools · ${elapsed}s]`,
    );

    if (result.limitations.length > 0) {
      console.log(`   limitations: ${result.limitations.join(' | ')}`);
    }

    // Withheld and retried are worth separating: the first means no usable
    // answer was produced, the second means the guard caught a bad draft and
    // the rewrite passed. Both are worth knowing about; only one is a failure.
    if (result.attributionOutcome === 'withheld') {
      violations += 1;
      console.log('   [31m§0.1 GUARD FIRED:[0m');
      for (const warning of result.attributionWarnings) console.log(`     ${warning}`);
    } else if (result.attributionOutcome === 'retried') {
      retries += 1;
      console.log('   §0.1 draft rejected, rewrite passed:');
      for (const warning of result.attributionWarnings) console.log(`     ${warning}`);
    } else {
      console.log('   [32m§0.1 clean — every figure traced to the bundle.[0m');
    }
    console.log();
  }

  console.log('─'.repeat(76));
  console.log(
    violations === 0
      ? `All ${QUESTIONS.length} answer(s) passed the attribution guard.`
      : `${violations} of ${QUESTIONS.length} answer(s) were withheld — see above.`,
  );
  if (retries > 0) {
    console.log(
      `${retries} answer(s) needed a rewrite before passing — a second synthesis call each.`,
    );
  }
} finally {
  await closeDb();
}
