/**
 * Checkpoint 2's real question (§8, STATE.md): does the model attribute, or
 * does it confabulate? These tests cover the detector that answers it.
 *
 * Note what is being tested. Not "does Claude behave" — that is a live-model
 * question and belongs in an eval. This is the narrower, deterministic half:
 * given a bundle and a piece of prose, do we correctly identify figures the
 * bundle never authorised? If this is wrong, the guard is decorative.
 */

import { describe, expect, it } from 'vitest';
import { checkAttribution, allowedFigures } from './attribution.js';
import { summaryOverview } from '../workflows/summaryOverview.js';
import { runWorkflow } from '../workflows/index.js';
import { TEST_USER_ID, typicalSnapshot } from '../testing/fixtures.js';

const SIXTY_K = 6_000_000n;
const ctx = () => ({ userId: TEST_USER_ID, snapshot: typicalSnapshot() });

const bundleFor = async () => {
  const { bundle } = await summaryOverview(ctx(), { annualSpendCents: SIXTY_K });
  return bundle;
};

describe('attribution guard', () => {
  it('accepts a figure the bundle actually produced', async () => {
    const bundle = await bundleFor();
    // 38_224_095n cents — the net worth the fixture computes.
    const report = checkAttribution('Your net worth is $382,240.95 right now.', bundle);

    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('catches a figure that appears nowhere in the bundle', async () => {
    const bundle = await bundleFor();
    const report = checkAttribution('Your net worth is $999,999.99 right now.', bundle);

    expect(report.ok).toBe(false);
    expect(report.violations[0]?.figure).toBe('$999,999.99');
    expect(report.violations[0]?.kind).toBe('currency');
  });

  it('catches the model doing arithmetic in prose', async () => {
    const bundle = await bundleFor();
    // The failure mode §0.1 names explicitly: the model sums two real figures
    // and states the total. Both inputs are authorised; the sum is not.
    const report = checkAttribution(
      'Your cash and investments together come to $412,806.11.',
      bundle,
    );

    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.figure)).toContain('$412,806.11');
  });

  it('allows rounding to whole dollars and thousands', async () => {
    const bundle = await bundleFor();
    // A coach that must quote cents every time reads like a receipt. Lower
    // precision on an authorised figure is the same figure, not a new one.
    for (const text of [
      'about $382,241',
      'roughly $382,200',
      'a bit over $382,000',
    ]) {
      expect(checkAttribution(text, bundle).ok).toBe(true);
    }
  });

  it('does not let rounding smuggle in an unrelated figure', async () => {
    const bundle = await bundleFor();
    // $390,000 is not any authorised figure rounded — the tolerance must not
    // be wide enough to wave through a number the tools never produced.
    expect(checkAttribution('about $390,000', bundle).ok).toBe(false);
  });

  it('accepts a debt stated as a positive amount owed', async () => {
    // goal_progress, not summary_overview: its pipeline is getUserContext →
    // netWorth → fireProgress, with no getBalances step to supply the owed-amount
    // form of a balance. netWorth's lines are therefore the only place an account
    // appears, and they were signed-only — so "your card balance is $2,310.20",
    // the way anyone would actually say it, read as an unattributable figure and
    // pushed the model into writing minus signs into prose.
    const { bundle } = await runWorkflow('goal_progress', ctx(), {
      annualSpendCents: SIXTY_K,
    });

    expect(checkAttribution('Your card balance is $2,310.20.', bundle).ok).toBe(true);
    expect(checkAttribution('That card pulls -$2,310.20 off your net worth.', bundle).ok).toBe(true);
  });

  it('still catches a sign flip on a total', async () => {
    const bundle = await bundleFor();
    // Matching is sign-aware by design. Authorising the owed-amount form of an
    // account balance must not make the guard blind to a figure whose sign is
    // simply wrong — "-$382,240.95" is a materially different claim.
    expect(checkAttribution('Your net worth is -$382,240.95.', bundle).ok).toBe(false);
  });

  it('checks percentages as well as currency', async () => {
    const bundle = await bundleFor();

    expect(checkAttribution('You are 61.9% of the way there.', bundle).ok).toBe(false);
    expect(checkAttribution('That is 0% of your target.', bundle).ok).toBe(true);
  });

  it('always permits zero', async () => {
    const bundle = await bundleFor();
    // "You have no credit card debt" is worth being able to say plainly.
    expect(checkAttribution('You carry $0.00 in credit card debt.', bundle).ok).toBe(true);
  });

  it('reports enough context to debug a violation', async () => {
    const bundle = await bundleFor();
    const report = checkAttribution(
      'Looking across everything, I estimate your total at $123,456.78 today.',
      bundle,
    );

    expect(report.violations[0]?.context).toContain('estimate your total');
  });

  it('derives its allowed set from the humanised bundle, not raw cents', async () => {
    const bundle = await bundleFor();
    const { display, currencyCents } = allowedFigures(bundle);

    // The pre-formatted siblings are what the model sees (§ present.ts), so
    // they are what the guard must be built from.
    expect(display.some((d) => d.includes('$382,240.95'))).toBe(true);
    expect(currencyCents.has('38224095')).toBe(true);
  });

  it('passes clean prose that states no figures at all', async () => {
    const bundle = await bundleFor();
    const report = checkAttribution(
      'Your accounts are spread across a few institutions, and your allocation ' +
        'leans heavily toward funds whose internal mix I cannot see.',
      bundle,
    );

    expect(report.ok).toBe(true);
  });
});
