import { describe, expect, it } from 'vitest';
import { EMPTY_TRACE, TraceRecorder } from './trace.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('TraceRecorder', () => {
  it('records a successful call with its scope, label, and count', async () => {
    const recorder = new TraceRecorder();

    const value = await recorder.track(
      'plaid',
      '/accounts/balance/get',
      async () => ['a', 'b', 'c'],
      (v) => ({ count: v.length }),
    );

    expect(value).toEqual(['a', 'b', 'c']);
    const trace = recorder.build();
    expect(trace.entries).toHaveLength(1);
    expect(trace.entries[0]).toMatchObject({
      scope: 'plaid',
      label: '/accounts/balance/get',
      ok: true,
      count: 3,
    });
  });

  it('records a failed call and re-throws the original error', async () => {
    const recorder = new TraceRecorder();
    const boom = new Error('plaid said no');

    await expect(
      recorder.track('plaid', '/investments/holdings/get', async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const [entry] = recorder.build().entries;
    expect(entry?.ok).toBe(false);
  });

  it('never puts the error message in the trace', async () => {
    // Plaid errors can quote the request that produced them, so the panel gets
    // "failed" and the human reason travels as a snapshot gap instead (§9).
    const recorder = new TraceRecorder();
    const secret = 'access-sandbox-11111111-2222-3333';

    await expect(
      recorder.track('plaid', '/transactions/get', async () => {
        throw new Error(`request failed for ${secret}`);
      }),
    ).rejects.toThrow();

    const serialised = JSON.stringify(recorder.build());
    expect(serialised).not.toContain(secret);
    expect(serialised).not.toContain('request failed');
  });

  it('reports wall-clock elapsed time, not the sum of overlapping calls', async () => {
    // Three calls in parallel, each ~40ms, should report ~40ms and not ~120ms.
    // A sum would overstate what the user actually waited for.
    const recorder = new TraceRecorder();

    await Promise.all([
      recorder.track('plaid', 'a', () => sleep(40)),
      recorder.track('plaid', 'b', () => sleep(40)),
      recorder.track('plaid', 'c', () => sleep(40)),
    ]);

    const trace = recorder.build();
    const summed = trace.entries.reduce((total, e) => total + e.durationMs, 0);
    expect(trace.entries).toHaveLength(3);
    expect(trace.totalMs).toBeLessThan(summed);
  });

  it('groups calls by scope with per-scope totals', async () => {
    const recorder = new TraceRecorder();

    await recorder.track('plaid', 'one', async () => null);
    await recorder.track('plaid', 'two', async () => null);
    await recorder.track('anthropic', 'claude-haiku-4-5', async () => null);

    const trace = recorder.build();
    const plaid = trace.byScope.find((b) => b.scope === 'plaid');
    const anthropic = trace.byScope.find((b) => b.scope === 'anthropic');

    expect(plaid?.calls).toBe(2);
    expect(anthropic?.calls).toBe(1);
  });

  it('is an empty trace when nothing was recorded', () => {
    expect(new TraceRecorder().build()).toEqual(EMPTY_TRACE);
  });

  it('survives JSON, since the chat route sends it to the browser', async () => {
    const recorder = new TraceRecorder();
    await recorder.track('anthropic', 'claude-sonnet-5', async () => null, () => ({
      detail: 'synthesis',
    }));

    const round = JSON.parse(JSON.stringify(recorder.build()));
    expect(round.entries[0].detail).toBe('synthesis');
  });

  it('annotates the most recent entry without touching earlier ones', async () => {
    const recorder = new TraceRecorder();
    await recorder.track('anthropic', 'first', async () => null, () => ({ detail: 'synthesis' }));
    await recorder.track('anthropic', 'second', async () => null);
    recorder.annotate('retry');

    const trace = recorder.build();
    expect(trace.entries[0]?.detail).toBe('synthesis');
    expect(trace.entries[1]?.detail).toBe('retry');
  });
});
