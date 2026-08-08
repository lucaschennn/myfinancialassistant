/**
 * The network trace, rendered (§0.2, §8 Phase 1.5-A).
 *
 * §7 refetches from Plaid on every render and every chat turn rather than
 * caching. That is a deliberate trade — no raw financial PII at rest, paid for
 * in latency — and this panel is where the user gets to see the bill.
 *
 * Deliberately NOT a loading state. The point is not to soften the wait but to
 * make the cost legible after the fact: which of our routes ran, which external
 * services were called, how long each took, and whether it worked.
 *
 * One honest wrinkle worth the copy it costs: the dashboard is a server
 * component that calls Plaid during its own render, so there is no
 * `/api/...` request in the browser's network tab to match this against. The
 * panel describes work done on the server for a view, not requests the browser
 * made. Saying so is cheaper than letting someone conclude the panel is lying.
 */

/*
 * TYPE-ONLY import from `@pfg/core`, and it has to stay that way. This
 * component is rendered by `Chat.tsx`, which is a client component, so any
 * runtime value imported here is followed into the browser bundle — and
 * `@pfg/core`'s entry point reaches `@pfg/db`, which reaches `postgres`, which
 * needs `net` and `node:url`. The build fails with "Module not found: Can't
 * resolve 'net'", which reads like a bundler problem and is actually this.
 *
 * Type imports are erased at compile time, so they are free. Presentation
 * labels therefore live here rather than in `core` — the same reason `Chat.tsx`
 * keeps its own copy of the provenance source labels.
 */
import type { NetworkTrace, TraceScope } from '@pfg/core';

const SCOPE_LABELS: Record<TraceScope, string> = {
  internal: 'this app',
  plaid: 'Plaid',
  anthropic: 'Anthropic',
  db: 'Postgres',
};

const SCOPE_ORDER: TraceScope[] = ['internal', 'plaid', 'anthropic', 'db'];

function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

export function NetworkPanel({
  trace,
  label = 'What this cost',
}: {
  trace: NetworkTrace;
  label?: string;
}) {
  if (trace.entries.length === 0) return null;

  const external = trace.entries.filter(
    (e) => e.scope === 'plaid' || e.scope === 'anthropic',
  ).length;
  const byScope = [...trace.byScope].sort(
    (a, b) => SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope),
  );

  return (
    <details className="evidence trace">
      <summary>
        {label} · {trace.entries.length} call{trace.entries.length === 1 ? '' : 's'} ·{' '}
        {ms(trace.totalMs)}
      </summary>
      <div className="evidence-body">
        <p className="prov" style={{ marginBottom: 10 }}>
          {external === 0
            ? 'No external services were called.'
            : `${external} call${external === 1 ? '' : 's'} left this server. Nothing was cached — ` +
              'your financial data is fetched live and discarded when the request ends.'}
        </p>

        <div className="scope-row">
          {byScope.map((bucket) => (
            <span className={`scope-chip scope-${bucket.scope}`} key={bucket.scope}>
              {SCOPE_LABELS[bucket.scope]} · {bucket.calls} · {ms(bucket.totalMs)}
            </span>
          ))}
        </div>

        <table className="trace-table">
          <tbody>
            {trace.entries.map((entry, i) => (
              <tr key={`${entry.label}-${i}`} className={entry.ok ? '' : 'trace-failed'}>
                <td>
                  <span className={`scope-chip scope-${entry.scope}`}>
                    {SCOPE_LABELS[entry.scope]}
                  </span>
                </td>
                <td className="trace-label">{entry.label}</td>
                <td className="muted">
                  {entry.detail}
                  {entry.count !== undefined && (
                    <>
                      {entry.detail ? ' · ' : ''}
                      {entry.count} item{entry.count === 1 ? '' : 's'}
                    </>
                  )}
                </td>
                <td className="num muted">{ms(entry.durationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="faint" style={{ marginTop: 10 }}>
          Endpoint names, timings, and counts only — never the contents of a request or
          response. This trace is built per request and never stored.
        </p>
      </div>
    </details>
  );
}
