/**
 * The payload test is the important one here.
 *
 * If a raw `…Cents` integer ever reaches the model without its formatted
 * sibling, the model has to divide by 100 to say anything — and §0.1 is broken
 * at the source rather than at the guard. That is worth a test that fails
 * loudly.
 */

import { describe, expect, it } from 'vitest';
import {
  JOLLY_SYSTEM_PROMPT,
  attributionRetryTurn,
  evidencePayload,
  synthesisUserTurn,
} from './prompt.js';
import { summaryOverview } from '../workflows/summaryOverview.js';
import { TEST_USER_ID, typicalSnapshot } from '../testing/fixtures.js';

const SIXTY_K = 6_000_000n;
const run = () =>
  summaryOverview({ userId: TEST_USER_ID, snapshot: typicalSnapshot() }, {
    annualSpendCents: SIXTY_K,
  });

describe('evidence payload', () => {
  it('gives the model formatted figures, never bare cents to divide', async () => {
    const { bundle } = await run();
    const payload = evidencePayload(bundle);

    // The formatted sibling must be present...
    expect(payload).toContain('$382,240.95');
    // ...alongside the integer it came from, so provenance stays exact.
    expect(payload).toContain('"netWorthCents": "38224095"');
  });

  it('serialises without bigint throwing', async () => {
    const { bundle } = await run();
    expect(() => JSON.parse(evidencePayload(bundle))).not.toThrow();
  });

  it('carries provenance and gap notes into the prompt', async () => {
    const { bundle } = await run();
    const payload = JSON.parse(evidencePayload(bundle)) as {
      steps: Array<{ tool: string; howItWasComputed?: string; gapsAndCaveats?: string[] }>;
    };

    const netWorth = payload.steps.find((s) => s.tool === 'netWorth');
    expect(netWorth?.howItWasComputed).toBeTruthy();

    // §6 honest-about-gaps only works if the gaps reach the model at all.
    const allocation = payload.steps.find((s) => s.tool === 'assetAllocation');
    expect(allocation?.gapsAndCaveats?.join(' ')).toMatch(/fund|ETF|mutual/i);
  });

  it('passes limitations through so the model can admit a missing step', async () => {
    const { bundle } = await summaryOverview(
      { userId: TEST_USER_ID, snapshot: typicalSnapshot() },
      {},
    );
    const payload = evidencePayload(bundle, [
      { tool: 'fireProgress', reason: 'This needs a target for your annual spending.' },
    ]);

    // The model sees which step is missing, not just that something is — so it
    // can name the gap in its answer rather than gesturing at it (§6).
    expect(payload).toContain('limitations');
    expect(payload).toContain('fireProgress');
    expect(payload).toContain('target for your annual spending');
  });

  it('puts evidence before the question so the stable part comes first', async () => {
    const { bundle } = await run();
    const turn = synthesisUserTurn({ bundle, question: 'How am I doing?' });

    expect(turn.indexOf('<evidence>')).toBeLessThan(turn.indexOf('How am I doing?'));
  });
});

describe('Jolly system prompt', () => {
  it('states the no-arithmetic rule in terms a model can act on', () => {
    expect(JOLLY_SYSTEM_PROMPT).toMatch(/never calculate/i);
    // The subtle case is the one worth pinning: combining two given figures.
    expect(JOLLY_SYSTEM_PROMPT).toMatch(/combine two figures/i);
  });

  it('encodes the educational-not-advisor boundary (§6)', () => {
    expect(JOLLY_SYSTEM_PROMPT).toMatch(/not a licensed advisor/i);
    expect(JOLLY_SYSTEM_PROMPT).toMatch(/never issue directives/i);
  });

  it('requires attribution without citation markers', () => {
    expect(JOLLY_SYSTEM_PROMPT).toMatch(/attribution/i);
    expect(JOLLY_SYSTEM_PROMPT).toMatch(/do not use citation markers/i);
  });
});

describe('attribution retry turn', () => {
  it('names the offending figures so the correction is actionable', () => {
    const turn = attributionRetryTurn(['$65,262', '$56,302']);
    expect(turn).toContain('$65,262');
    expect(turn).toContain('$56,302');
  });

  it('tells the model the correction is invisible to the person', () => {
    // The retry arrives as a `user` turn, so without this the model answers it
    // conversationally — "You're right to flag that, let me restate…" — to
    // someone who never saw the draft and said nothing of the kind.
    const turn = attributionRetryTurn(['$1.00']);

    expect(turn).toMatch(/never saw your draft/i);
    expect(turn).toMatch(/do not acknowledge it/i);
    expect(turn).toMatch(/standalone answer/i);
  });
});
