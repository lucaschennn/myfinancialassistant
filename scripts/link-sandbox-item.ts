/**
 * Phase 0 stand-in for the Plaid Link UI (§7.1, built for real in Phase 1).
 *
 * Creates a sandbox user if needed, mints a sandbox public_token, exchanges it
 * for an access_token, and stores that token encrypted.
 *
 *   npm run link:sandbox -- --show          print the user id and linked items, link nothing
 *   npm run link:sandbox                    link First Platypus Bank if not already linked
 *   npm run link:sandbox -- --institution ins_56  link a different sandbox bank
 *   npm run link:sandbox -- --force         link the same bank a second time (see below)
 *
 * Idempotency matters here in a way that is easy to miss: Plaid's
 * `sandboxPublicTokenCreate` mints a NEW item id on every call, so nothing ever
 * conflicts on insert. Without the check below, re-running this would quietly
 * give the user two items for the same bank — and `fetchSnapshot` reads every
 * active item, so their accounts and net worth would double.
 */

import { closeDb, getDb, loadEnv, plaidItems, users } from '@pfg/db';
import { createSandboxItem } from '@pfg/plaid';
import { and, eq } from 'drizzle-orm';

loadEnv();

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}
const has = (name: string): boolean => argv.includes(`--${name}`);

const email = flag('email') ?? 'sandbox@example.test';
const institutionId = flag('institution') ?? 'ins_109508';

if ((process.env.PLAID_ENV ?? 'sandbox') !== 'sandbox') {
  console.error('Refusing to run: PLAID_ENV must be "sandbox".');
  process.exit(1);
}

const db = getDb();

try {
  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user =
    existing[0] ?? (await db.insert(users).values({ email, authProviderId: null }).returning())[0];

  if (!user) throw new Error('Could not create or find the sandbox user.');

  console.log(`User: ${user.id}  (${email})`);
  console.log(`  MCP_DEV_USER_ID=${user.id}`);

  const items = await db
    .select()
    .from(plaidItems)
    .where(and(eq(plaidItems.userId, user.id), eq(plaidItems.status, 'active')));

  if (items.length > 0) {
    console.log(`\nAlready linked (${items.length} active item(s)):`);
    for (const item of items) {
      console.log(`  ${item.institutionName ?? item.institutionId} — ${item.plaidItemId}`);
    }
  }

  if (has('show')) process.exit(0);

  const alreadyLinked = items.some((i) => i.institutionId === institutionId);
  if (alreadyLinked && !has('force')) {
    console.log(
      `\n${institutionId} is already linked — nothing to do. Every sandbox link mints a new\n` +
        'item, so linking again would duplicate this bank\'s accounts and double the\n' +
        'computed net worth. Pass --force if a second item is genuinely what you want.',
    );
    process.exit(0);
  }

  const summary = await createSandboxItem({ userId: user.id, db, institutionId });

  console.log(`\nLinked: ${summary.institutionName ?? institutionId}`);
  console.log(`  plaid item id : ${summary.plaidItemId}`);
  console.log(`  accounts      : ${summary.accountCount}`);
} finally {
  await closeDb();
}
