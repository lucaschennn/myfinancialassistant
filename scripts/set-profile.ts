/**
 * Dev utility: set profile figures without a UI (Phase 1 replaces this with the
 * real onboarding flow). Exercises the `setProfile` core tool rather than
 * writing SQL directly, so it validates the same path the app will use.
 *
 *   npm run set:profile -- --spend 60000 --income 120000 --risk moderate
 *
 * Amounts are given in DOLLARS here for typing convenience and converted at the
 * boundary — the stored values are integer cents like everything else.
 */

import { dollarsToCents, getProfile, setProfile } from '@pfg/core';
import { closeDb, getDb, loadEnv, users } from '@pfg/db';

loadEnv();

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

const db = getDb();

try {
  let userId = flag('user') ?? process.env.MCP_DEV_USER_ID;
  if (!userId) {
    const [first] = await db.select().from(users).limit(1);
    if (!first) throw new Error('No users exist. Run `npm run link:sandbox` first.');
    userId = first.id;
  }

  const ctx = { userId, db };
  const spend = flag('spend');
  const income = flag('income');
  const risk = flag('risk');

  const params: Parameters<typeof setProfile>[1] = {};
  if (spend !== undefined) params.targetAnnualSpendCents = dollarsToCents(Number(spend));
  if (income !== undefined) params.annualIncomeCents = dollarsToCents(Number(income));
  if (risk !== undefined) params.riskTolerance = risk;

  if (Object.keys(params).length > 0) await setProfile(ctx, params);

  const { data } = await getProfile(ctx);
  console.log(`Profile for ${userId}:`);
  console.log(`  annual income      : ${data.annualIncomeCents ?? '(unset)'} cents`);
  console.log(`  target annual spend: ${data.targetAnnualSpendCents ?? '(unset)'} cents`);
  console.log(`  risk tolerance     : ${data.riskTolerance ?? '(unset)'}`);
} finally {
  await closeDb();
}
