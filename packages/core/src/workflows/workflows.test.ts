/**
 * The remaining five §5 pipelines.
 *
 * Same shape of test as `summaryOverview.test.ts`: the tool sequence is fixed
 * and provenance-backed. What is being pinned is the *order* — a workflow whose
 * steps can be reordered is not a constrained pipeline, it is a suggestion.
 */

import { describe, expect, it } from 'vitest';
import { implementedWorkflows, runWorkflow } from './index.js';
import { ROUTER_SCHEMA } from '../agent/router.js';
import { toReasoningTrace } from '../provenance.js';
import { toJson } from '../money.js';
import { TEST_USER_ID, snapshot, typicalSnapshot } from '../testing/fixtures.js';

const ctx = (snap = typicalSnapshot()) => ({ userId: TEST_USER_ID, snapshot: snap });
const tools = (entries: Array<{ tool: string }>) => entries.map((e) => e.tool);

describe('registry', () => {
  it('implements every workflow the router can emit', () => {
    // The Phase 0 gap is closed: routing can no longer land on a pipeline that
    // does not exist and silently degrade to the summary.
    const routable = [...ROUTER_SCHEMA.properties.workflow.enum].sort();
    expect(implementedWorkflows().sort()).toEqual(routable);
  });
});

describe('spending_analysis', () => {
  it('runs its four tools in the order the spec fixes', async () => {
    const { bundle } = await runWorkflow('spending_analysis', ctx(), {
      period: { from: '2026-05-01', to: '2026-08-01' },
    });

    expect(tools(bundle.entries)).toEqual([
      'getTransactions',
      'spendingByCategory',
      'cashFlow',
      'savingsRate',
    ]);
  });

  it('defaults to the fetched window when the router names no period', async () => {
    const { bundle } = await runWorkflow('spending_analysis', ctx(), {});
    const entry = bundle.entries.find((e) => e.tool === 'getTransactions');

    // Defaulting to the snapshot's own window means the answer is never
    // quietly narrower than the data available.
    expect(entry?.params).toMatchObject({ from: expect.any(String), to: expect.any(String) });
    expect(bundle.entries.every((e) => e.provenance.asOf)).toBe(true);
  });

  it('reports an uncomputable savings rate as null with a reason, not a failure', async () => {
    // An empty snapshot has no deposits. `savingsRate` deliberately does not
    // throw here — it returns a null ratio and explains why, which is a more
    // useful answer than a missing step ("your paycheck may land in an
    // account you have not linked").
    const { bundle } = await runWorkflow('spending_analysis', ctx(snapshot()), {});
    const entry = bundle.entries.find((e) => e.tool === 'savingsRate');

    expect(entry).toBeDefined();
    expect((entry?.data as { savingsRateBasisPoints: number | null }).savingsRateBasisPoints).toBe(
      null,
    );
    expect(entry?.provenance.notes?.join(' ')).toMatch(/no income was recorded/i);
  });

  it('gives every entry provenance', async () => {
    const { bundle } = await runWorkflow('spending_analysis', ctx(), {});
    for (const entry of bundle.entries) {
      expect(entry.provenance.source).toBeTruthy();
      expect(entry.provenance.computation).toBeTruthy();
    }
  });
});

describe('investment_review', () => {
  it('runs getHoldings then assetAllocation', async () => {
    const { bundle } = await runWorkflow('investment_review', ctx(), {});
    expect(tools(bundle.entries)).toEqual(['getHoldings', 'assetAllocation']);
  });

  it('says so plainly when nothing is held, rather than showing an empty table', async () => {
    const { limitations } = await runWorkflow('investment_review', ctx(snapshot()), {});
    expect(limitations[0]?.tool).toBe('getHoldings');
    expect(limitations[0]?.reason).toMatch(/no investment holdings/i);
  });

  it('carries the fund-lookthrough caveat into provenance (§6)', async () => {
    const { bundle } = await runWorkflow('investment_review', ctx(), {});
    const allocation = bundle.entries.find((e) => e.tool === 'assetAllocation');

    expect(allocation?.provenance.notes?.join(' ')).toMatch(/fund|ETF|mutual/i);
  });
});

describe('goal_progress', () => {
  it('reads context, then position, then progress', async () => {
    // No db on ctx, so getUserContext degrades — the remaining order still holds.
    const { bundle } = await runWorkflow('goal_progress', ctx(), {
      annualSpendCents: 6_000_000n,
    });

    expect(tools(bundle.entries)).toEqual(['netWorth', 'fireProgress']);
  });

  it('anchors the percentage to the net worth it came from', async () => {
    const { bundle } = await runWorkflow('goal_progress', ctx(), {
      annualSpendCents: 6_000_000n,
    });

    // A progress figure with no underlying position is exactly the kind of
    // unanchored number §0.2 exists to prevent.
    expect(tools(bundle.entries)).toContain('netWorth');
    expect(tools(bundle.entries)).toContain('fireProgress');
  });

  it('reports a missing spend target instead of inventing one', async () => {
    const { limitations } = await runWorkflow('goal_progress', ctx(), {});
    expect(limitations.some((l) => l.tool === 'fireProgress')).toBe(true);
  });

  it('honours an explicit withdrawal rate over the default multiple', async () => {
    const { bundle } = await runWorkflow('goal_progress', ctx(), {
      annualSpendCents: 6_000_000n,
      withdrawalRate: 0.04,
    });
    const fire = bundle.entries.find((e) => e.tool === 'fireProgress');

    expect((fire?.data as { basis: { kind: string } }).basis.kind).toBe('withdrawal_rate');
  });
});

describe('transaction_lookup', () => {
  it('runs exactly one tool — there is nothing to derive', async () => {
    const { bundle } = await runWorkflow('transaction_lookup', ctx(), {});
    expect(tools(bundle.entries)).toEqual(['getTransactions']);
  });

  it('includes transfers and pending, unlike the cash-flow path', async () => {
    const { bundle } = await runWorkflow('transaction_lookup', ctx(), {});

    // "Did I pay X" is a different question from "what did I spend": a
    // transfer is still a payment the person made, and a pending charge is
    // often the exact one being asked about.
    expect(bundle.entries[0]?.params).toMatchObject({
      excludeTransfers: false,
      includePending: true,
    });
  });

  it('states the search window when nothing matched', async () => {
    const { limitations } = await runWorkflow('transaction_lookup', ctx(snapshot()), {
      period: { from: '2020-01-01', to: '2020-01-31' },
    });

    // Otherwise "no, you never paid that" silently means "not in 90 days".
    expect(limitations[0]?.tool).toBe('getTransactions');
    expect(limitations[0]?.reason).toMatch(/2020-01-01/);
    expect(limitations[0]?.reason).toMatch(/only covers the transactions fetched/i);
  });
});

describe('general_qa', () => {
  it('runs a bounded subset — no transactions, no holdings, no compute', async () => {
    const { bundle } = await runWorkflow('general_qa', ctx(), {});

    expect(tools(bundle.entries)).toEqual(['listAccounts']);
    // The bound is what makes this a constrained fallback (§5) rather than an
    // escape hatch from the workflow model.
    expect(tools(bundle.entries)).not.toContain('getTransactions');
    expect(tools(bundle.entries)).not.toContain('netWorth');
  });

  it('still answers when there is no snapshot at all', async () => {
    const { bundle, limitations } = await runWorkflow('general_qa', { userId: TEST_USER_ID }, {});

    expect(bundle.entries).toEqual([]);
    expect(limitations[0]?.tool).toBe('listAccounts');
    expect(limitations[0]?.reason).toMatch(/no account data/i);
  });
});

describe('every workflow', () => {
  const names = implementedWorkflows();

  it('produces a reasoning trace carrying no financial values', async () => {
    for (const name of names) {
      const { bundle } = await runWorkflow(name, ctx(), { annualSpendCents: 6_000_000n });
      const serialised = toJson(toReasoningTrace(bundle));

      // insight_log must never become a PII store (§3, §5). The subtle leak is
      // params, not data: `annualSpendCents` is the user's own spending target
      // — a financial figure that rides along in the tool call rather than in
      // its result, and so survives a check that only looks at values.
      expect(serialised, name).not.toMatch(/Cents"\s*:\s*"?\d/);
      expect(serialised, name).not.toContain('6000000');
    }
  });

  it('keeps the shape of a redacted param so the trace stays auditable', async () => {
    const { bundle } = await runWorkflow('goal_progress', ctx(), {
      annualSpendCents: 6_000_000n,
    });
    const trace = toReasoningTrace(bundle);
    const fire = trace.toolCalls.find((c) => c.tool === 'fireProgress');

    // "A spend target was supplied" is exactly what an audit trail needs;
    // "the target was $60,000" is exactly what it must not keep.
    expect(fire?.params).toEqual({ annualSpendCents: '[redacted]' });
  });

  it('serialises to JSON without bigint blowing up', async () => {
    for (const name of names) {
      const { bundle } = await runWorkflow(name, ctx(), { annualSpendCents: 6_000_000n });
      expect(() => JSON.parse(toJson(bundle)), name).not.toThrow();
    }
  });

  it('names the step behind every limitation that is a failed step', async () => {
    // A "why" card showing "not available" with no subject tells the reader
    // nothing. Either the limitation names its tool, or it is explicitly a
    // statement about the answer as a whole.
    for (const name of names) {
      const { limitations } = await runWorkflow(name, ctx(snapshot()), {});
      for (const limitation of limitations) {
        expect(limitation.reason.length, `${name}: empty reason`).toBeGreaterThan(0);
        if (limitation.tool !== undefined) {
          expect(limitation.tool, `${name}: blank tool`).not.toBe('');
        }
      }
    }
  });

  it('writes limitations for a person, not for a developer', async () => {
    // The bug this pins: dumping a thrown Error into `reason` put
    // "Pass `annualSpendCents` ... via setProfile" on a user's screen —
    // internal API guidance, plus the tool name repeated inside its own message.
    for (const name of names) {
      for (const params of [{}, { annualSpendCents: 6_000_000n }]) {
        const { limitations } = await runWorkflow(name, ctx(snapshot()), params);
        for (const { tool, reason } of limitations) {
          expect(reason, `${name}: leaked a parameter name`).not.toMatch(
            /annualSpendCents|targetAnnualSpendCents|setProfile|ctx\./,
          );
          expect(reason, `${name}: leaked a backtick-quoted identifier`).not.toMatch(/`\w+`/);
          if (tool) {
            expect(reason, `${name}: repeats its own tool name`).not.toContain(`${tool}:`);
          }
        }
      }
    }
  });

  it('stamps its own name on the bundle', async () => {
    for (const name of names) {
      const { bundle } = await runWorkflow(name, ctx(), { annualSpendCents: 6_000_000n });
      expect(bundle.workflow, name).toBe(name);
      expect(bundle.userId, name).toBe(TEST_USER_ID);
    }
  });
});
