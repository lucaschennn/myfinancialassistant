/**
 * Checkpoint 1, part 1 (§8): the fixed pipeline is validated by calling the
 * workflow executor directly — never through MCP, where Claude Code chooses the
 * tool order itself and would prove nothing about this pipeline (§1).
 *
 * These run on fixtures. `scripts/checkpoint1-summary.ts` runs the same
 * executor against a live Plaid sandbox fetch.
 */

import { describe, expect, it } from 'vitest';
import { summaryOverview } from './summaryOverview.js';
import { runWorkflow } from './index.js';
import { toReasoningTrace } from '../provenance.js';
import { toJson } from '../money.js';
import { TEST_USER_ID, snapshot, typicalSnapshot } from '../testing/fixtures.js';

const ctx = (snap = typicalSnapshot()) => ({ userId: TEST_USER_ID, snapshot: snap });
const SIXTY_K = 6_000_000n;

describe('summary_overview workflow', () => {
  it('runs its five tools in the order the spec fixes', async () => {
    const { bundle } = await summaryOverview(ctx(), { annualSpendCents: SIXTY_K });

    expect(bundle.entries.map((e) => e.tool)).toEqual([
      'listAccounts',
      'getBalances',
      'netWorth',
      'assetAllocation',
      'fireProgress',
    ]);
  });

  it('gives every entry provenance — no figure without a source', async () => {
    const { bundle } = await summaryOverview(ctx(), { annualSpendCents: SIXTY_K });

    for (const entry of bundle.entries) {
      expect(entry.provenance.source).toBeTruthy();
      expect(entry.provenance.asOf).toBe('2026-08-01T12:00:00.000Z');
      expect(entry.provenance.computation).toBeTruthy();
    }
  });

  it('marks fetched data as plaid and derived figures as compute', async () => {
    const { bundle } = await summaryOverview(ctx(), { annualSpendCents: SIXTY_K });
    const source = (tool: string) =>
      bundle.entries.find((e) => e.tool === tool)?.provenance.source;

    expect(source('listAccounts')).toBe('plaid');
    expect(source('getBalances')).toBe('plaid');
    expect(source('netWorth')).toBe('compute');
    expect(source('assetAllocation')).toBe('compute');
    expect(source('fireProgress')).toBe('compute');
  });

  it('carries the same figures the compute functions produce', async () => {
    const { bundle } = await summaryOverview(ctx(), { annualSpendCents: SIXTY_K });
    const netWorthEntry = bundle.entries.find((e) => e.tool === 'netWorth');

    expect((netWorthEntry?.data as { netWorthCents: bigint }).netWorthCents).toBe(38_224_095n);
  });

  it('degrades rather than failing when no spend target is available', async () => {
    // No annualSpendCents and no db to read a profile from.
    const { bundle, limitations } = await summaryOverview(ctx(), {});

    expect(bundle.entries.map((e) => e.tool)).toEqual([
      'listAccounts',
      'getBalances',
      'netWorth',
      'assetAllocation',
    ]);
    expect(limitations.join(' ')).toMatch(/FIRE progress could not be calculated/);
  });

  it('still produces a bundle for a user with nothing linked', async () => {
    const { bundle } = await summaryOverview(ctx(snapshot()), { annualSpendCents: SIXTY_K });
    const netWorthEntry = bundle.entries.find((e) => e.tool === 'netWorth');

    expect((netWorthEntry?.data as { netWorthCents: bigint }).netWorthCents).toBe(0n);
  });

  it('serialises to JSON for the synthesis prompt without bigint blowing up', async () => {
    const { bundle } = await summaryOverview(ctx(), { annualSpendCents: SIXTY_K });
    const json = toJson(bundle);

    expect(() => JSON.parse(json)).not.toThrow();
    expect(json).toContain('"netWorthCents":"38224095"');
  });

  it('reduces to a reasoning trace that carries no financial values', async () => {
    const { bundle } = await summaryOverview(ctx(), { annualSpendCents: SIXTY_K });
    const trace = toReasoningTrace(bundle);
    const serialised = toJson(trace);

    // This is what insight_log persists (§3, §5) — tool names and provenance
    // only. If a figure ever leaks in here, the audit log has become a PII store.
    expect(serialised).not.toContain('38224095');
    expect(serialised).not.toContain('netWorthCents');
    expect(trace.toolCalls.map((c) => c.tool)).toHaveLength(5);
    expect(trace.toolCalls[2]?.provenance.computation).toBeTruthy();
  });

  it('is reachable through the registry by name', async () => {
    const { bundle } = await runWorkflow('summary_overview', ctx(), {
      annualSpendCents: SIXTY_K,
    });
    expect(bundle.workflow).toBe('summary_overview');
    expect(bundle.userId).toBe(TEST_USER_ID);
  });

  it('rejects a workflow that has not been implemented yet', async () => {
    await expect(runWorkflow('spending_analysis', ctx(), {})).rejects.toThrow(
      /No workflow registered/,
    );
  });
});
