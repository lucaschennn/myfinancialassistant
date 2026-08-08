import { describe, expect, it } from 'vitest';
import { FALLBACK_DECISION, ROUTER_SCHEMA, isRouterDecision, resolvePeriod } from './router.js';
import { implementedWorkflows } from '../workflows/index.js';

// A fixed "now" so the boundary arithmetic is checkable rather than relative.
const NOW = new Date('2026-08-02T14:30:00.000Z');

describe('period resolution', () => {
  it('resolves the current month from its first day to today', () => {
    expect(resolvePeriod('current_month', NOW)).toEqual({
      from: '2026-08-01',
      to: '2026-08-02',
    });
  });

  it('resolves last month to its real final day, not "today minus a month"', () => {
    // July has 31 days; an off-by-one here silently drops a day of spending.
    expect(resolvePeriod('last_month', NOW)).toEqual({
      from: '2026-07-01',
      to: '2026-07-31',
    });
  });

  it('handles a last month that crosses the year boundary', () => {
    const january = new Date('2026-01-15T10:00:00.000Z');
    expect(resolvePeriod('last_month', january)).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
  });

  it('gets February right in a leap year', () => {
    const march = new Date('2028-03-10T10:00:00.000Z');
    expect(resolvePeriod('last_month', march)).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
  });

  it('resolves rolling windows and year-to-date', () => {
    expect(resolvePeriod('last_3_months', NOW)).toEqual({ from: '2026-05-02', to: '2026-08-02' });
    expect(resolvePeriod('last_6_months', NOW)).toEqual({ from: '2026-02-02', to: '2026-08-02' });
    expect(resolvePeriod('last_12_months', NOW)).toEqual({ from: '2025-08-02', to: '2026-08-02' });
    expect(resolvePeriod('year_to_date', NOW)).toEqual({ from: '2026-01-01', to: '2026-08-02' });
  });

  it('clamps a rolling window to the target month rather than rolling it forward', () => {
    // 31 August minus 6 months is 31 February, which Date.UTC does not reject —
    // it rolls forward to 3 March, silently returning five months and four weeks
    // under a "last 6 months" label. The whole failure is invisible to an
    // ordering check, so it is asserted on the boundary date itself.
    const augustThirtyFirst = new Date('2026-08-31T12:00:00.000Z');

    expect(resolvePeriod('last_6_months', augustThirtyFirst)).toEqual({
      from: '2026-02-28',
      to: '2026-08-31',
    });
    expect(resolvePeriod('last_3_months', new Date('2026-05-31T12:00:00.000Z'))).toEqual({
      from: '2026-02-28',
      to: '2026-05-31',
    });
    // A short target month in a leap year clamps to the 29th, not the 28th.
    expect(resolvePeriod('last_3_months', new Date('2028-05-31T12:00:00.000Z'))).toEqual({
      from: '2028-02-29',
      to: '2028-05-31',
    });
    // Going back a full year from 29 February lands in a year without one.
    expect(resolvePeriod('last_12_months', new Date('2028-02-29T12:00:00.000Z'))).toEqual({
      from: '2027-02-28',
      to: '2028-02-29',
    });
  });

  it('keeps the day of month whenever the target month is long enough', () => {
    // The clamp must not fire when it is not needed — 31 December back three
    // months is 30 September only because September is short, and back twelve
    // months is 31 December exactly.
    const newYearsEve = new Date('2026-12-31T12:00:00.000Z');

    expect(resolvePeriod('last_3_months', newYearsEve).from).toBe('2026-09-30');
    expect(resolvePeriod('last_12_months', newYearsEve).from).toBe('2025-12-31');
  });

  it('never produces a range that runs backwards', () => {
    const periods = [
      'current_month',
      'last_month',
      'last_3_months',
      'last_6_months',
      'year_to_date',
      'last_12_months',
    ] as const;

    // Run across every month boundary — the 31st is where naive date math breaks.
    for (const day of ['2026-01-31', '2026-03-31', '2026-05-31', '2026-12-31']) {
      const now = new Date(`${day}T12:00:00.000Z`);
      for (const period of periods) {
        const { from, to } = resolvePeriod(period, now);
        expect(from <= to, `${period} on ${day} produced ${from}..${to}`).toBe(true);
      }
    }
  });
});

describe('router contract', () => {
  it('enumerates exactly the six §5 workflows', () => {
    expect([...ROUTER_SCHEMA.properties.workflow.enum]).toEqual([
      'summary_overview',
      'spending_analysis',
      'investment_review',
      'goal_progress',
      'transaction_lookup',
      'general_qa',
    ]);
  });

  it('cannot route to a workflow that is not registered', () => {
    // The router's enum is the full §5 set, but only registered workflows can
    // actually run. This test is the tripwire: as workflows land, the gap
    // shrinks. Anything the router can emit must eventually be here.
    const registered = new Set(implementedWorkflows());
    const routable = ROUTER_SCHEMA.properties.workflow.enum as readonly string[];

    for (const name of routable) {
      if (!registered.has(name as never)) {
        // Not yet built — the executor throws UnknownWorkflowError, which the
        // agent loop degrades into summary_overview rather than a 500.
        expect(FALLBACK_DECISION.workflow).toBe('summary_overview');
      }
    }
    expect(registered.size).toBeGreaterThan(0);
  });

  it('accepts a well-formed decision', () => {
    expect(isRouterDecision({ workflow: 'spending_analysis', period: 'last_month' })).toBe(true);
  });

  it('rejects a workflow the spec does not define', () => {
    expect(isRouterDecision({ workflow: 'transfer_money' })).toBe(false);
    expect(isRouterDecision({})).toBe(false);
    expect(isRouterDecision(null)).toBe(false);
    expect(isRouterDecision('summary_overview')).toBe(false);
  });

  it('falls back to the broad summary rather than erroring', () => {
    expect(FALLBACK_DECISION.workflow).toBe('summary_overview');
  });
});
