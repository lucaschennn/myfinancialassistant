'use client';

/**
 * The review screen (PHASE-2-INGESTION §5.1): the §0.8 human confirmation, the
 * place the sign convention is caught, and the only thing between a misread
 * figure and your records.
 *
 * This component holds DECISIONS, never figures. Every change is sent to the
 * server, which re-derives the draft from the original file and returns a view
 * made only of strings: what the document said, and what we made of it. No
 * amount is parsed, signed, or summed in the browser (§0.3).
 */

import type { NetworkTrace } from '@pfg/core';
import type { Decisions, DraftView, ReviewState } from '@pfg/ingest';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { NetworkPanel } from '../../NetworkPanel';

type View = NonNullable<ReviewState['view']>;
type FieldView = View['accounts'][number]['name'];

const ROLE_LABELS: Record<string, string> = {
  '': 'Not used',
  date: 'Date',
  description: 'Description',
  amount: 'Amount (signed)',
  debit: 'Money out',
  credit: 'Money in',
  balance: 'Running balance',
  merchant: 'Merchant',
  category: 'Category',
};

const TYPES: Array<[string, string]> = [
  ['depository', 'Bank account'],
  ['investment', 'Investment account'],
  ['credit', 'Credit card'],
  ['loan', 'Loan'],
  ['other', 'Other asset'],
];

function Origin({ field }: { field: Pick<FieldView, 'origin' | 'page' | 'confidence'> }) {
  // Who produced this value, in words. A model reading a figure must look
  // different from code parsing one, and from something you typed.
  const label = field.origin === 'transcribed' ? 'Read by AI' : field.origin === 'user' ? 'Edited by you' : 'From file';
  return (
    <span className={`origin origin-${field.origin}`}>
      {label}
      {field.page ? ` · p.${field.page}` : ''}
      {field.confidence === 'low' ? ' · check this' : ''}
    </span>
  );
}

function RawVsShown({ field }: { field: FieldView }) {
  return (
    <span>
      <span className="raw">{field.raw || '—'}</span>
      <span className="arrow"> → </span>
      <strong>{field.shown}</strong> <Origin field={field} />
    </span>
  );
}

export function ReviewScreen({
  initial,
  accounts,
  initialTrace,
}: {
  initial: View;
  accounts: Array<{ accountId: string; name: string; mask: string | null; type: string }>;
  initialTrace: NetworkTrace;
}) {
  const router = useRouter();
  const [view, setView] = useState<View>(initial);
  const [decisions, setDecisions] = useState<Decisions>(initial.decisions);
  const [trace, setTrace] = useState<NetworkTrace>(initialTrace);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const account = view.accounts[0]!;
  const [accountForm, setAccountForm] = useState({
    name: decisions.account?.name ?? account.name.shown.replace(/^—$/, ''),
    subtype: decisions.account?.subtype ?? (account.subtype.shown === '—' ? '' : account.subtype.shown),
    institutionName: decisions.account?.institutionName ?? (account.institutionName.shown === '—' ? '' : account.institutionName.shown),
    mask: decisions.account?.mask ?? (account.mask.shown === '—' ? '' : account.mask.shown),
  });

  async function apply(next: Decisions) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/documents/${view.documentId}/decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const json = (await response.json().catch(() => ({}))) as { review?: ReviewState; trace?: NetworkTrace; error?: string };
      if (!response.ok || !json.review?.view) throw new Error(json.error ?? 'That change did not apply.');
      setDecisions(next);
      setView(json.review.view);
      if (json.trace) setTrace(json.trace);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  const accountDecision = (over: Partial<NonNullable<Decisions['account']>> = {}) => ({
    ...(decisions.account ?? {}),
    ...(decisions.account?.existingAccountId ? {} : { name: accountForm.name, subtype: accountForm.subtype, institutionName: accountForm.institutionName, mask: accountForm.mask }),
    ...over,
  });

  async function commit() {
    setBusy(true);
    setError(null);
    setReasons([]);
    try {
      // Save any unsaved account details first, so what is committed is what is shown.
      if (!decisions.account?.existingAccountId) {
        await apply({ ...decisions, account: accountDecision() });
      }
      const response = await fetch(`/api/documents/${view.documentId}/commit`, { method: 'POST' });
      const json = (await response.json().catch(() => ({}))) as { error?: string; reasons?: string[] };
      if (!response.ok) {
        setReasons(json.reasons ?? []);
        throw new Error(json.error ?? 'Could not import this document.');
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    const response = await fetch(`/api/documents/${view.documentId}/reject`, { method: 'POST' });
    if (response.ok) {
      router.push('/import');
      router.refresh();
    } else {
      setError('Could not remove this document.');
      setBusy(false);
    }
  }

  const sign = view.signConvention;
  const blockers = view.blockers;
  const included = account.transactions.filter((t) => t.include).length;

  return (
    <div className="stack">
      {/* --- what is left ---------------------------------------------------- */}
      <div className="card">
        <h2>{blockers.length === 0 ? 'Ready to import' : 'Before this can be imported'}</h2>
        {blockers.length === 0 ? (
          <p className="card-sub">
            {included} transaction(s){account.balance ? ', a balance' : ''}
            {account.holdings.length ? `, ${account.holdings.length} holding(s)` : ''} will be added to your records.
          </p>
        ) : (
          <ul className="checklist">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
      </div>

      {/* --- the guard: what was dropped ------------------------------------- */}
      {view.dropped.length > 0 && (
        <div className="card">
          <h2>Dropped by the check</h2>
          <p className="card-sub">
            The AI reported these, but they do not appear in the statement as written, so they were
            discarded and will not be imported. If a real figure is here, enter it yourself below.
          </p>
          {view.dropped.map((d) => (
            <div className="note" key={`${d.label}-${d.raw}`}>
              <span className="note-tag">Dropped</span>
              {d.label}: <span className="raw">{d.raw}</span> — {d.reason}
            </div>
          ))}
        </div>
      )}

      {/* --- the account ------------------------------------------------------ */}
      <div className="card">
        <h2>Which account is this?</h2>
        <div className="form-grid">
          <label htmlFor="acct-target">Add these to</label>
          <select
            id="acct-target"
            value={decisions.account?.existingAccountId ?? ''}
            disabled={busy}
            onChange={(e) =>
              apply({
                ...decisions,
                account: e.target.value ? { existingAccountId: e.target.value } : { ...accountDecision(), existingAccountId: undefined },
              })
            }
          >
            <option value="">A new account</option>
            {accounts.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.name}
                {a.mask ? ` ····${a.mask}` : ''}
              </option>
            ))}
          </select>
          {!decisions.account?.existingAccountId && (
            <>
              <label htmlFor="acct-name">Account name</label>
              <input
                id="acct-name"
                value={accountForm.name}
                placeholder="Hometown Checking"
                onChange={(e) => setAccountForm({ ...accountForm, name: e.target.value })}
                onBlur={() => apply({ ...decisions, account: accountDecision() })}
              />
              <label htmlFor="acct-type">Kind of account</label>
              <div>
                <select
                  id="acct-type"
                  value={decisions.account?.type ?? account.type.shown}
                  disabled={busy}
                  onChange={(e) => apply({ ...decisions, account: accountDecision({ type: e.target.value }) })}
                >
                  {TYPES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                {account.type.origin === 'transcribed' && <p className="faint field-hint">Suggested from the statement — check it.</p>}
              </div>
              <label htmlFor="acct-inst">Institution</label>
              <input
                id="acct-inst"
                value={accountForm.institutionName}
                onChange={(e) => setAccountForm({ ...accountForm, institutionName: e.target.value })}
                onBlur={() => apply({ ...decisions, account: accountDecision() })}
              />
              <label htmlFor="acct-mask">Last 4 digits</label>
              <input
                id="acct-mask"
                value={accountForm.mask}
                maxLength={4}
                onChange={(e) => setAccountForm({ ...accountForm, mask: e.target.value })}
                onBlur={() => apply({ ...decisions, account: accountDecision() })}
              />
            </>
          )}
        </div>
      </div>

      {/* --- column mapping (CSV) ---------------------------------------------- */}
      {view.columns && (
        <div className="card">
          <h2>What each column means</h2>
          <p className="card-sub">Proposed from the headers and the values. Change any that are wrong.</p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Used as</th>
                </tr>
              </thead>
              <tbody>
                {view.columns.header.map((name, index) => {
                  const mapping = view.columns!.mapping as Record<string, number | undefined>;
                  const role = Object.entries(mapping).find(([, i]) => i === index)?.[0] ?? '';
                  return (
                    <tr key={index}>
                      <td>{name || `Column ${index + 1}`}</td>
                      <td>
                        <select
                          value={role}
                          disabled={busy}
                          aria-label={`Role of column ${name}`}
                          onChange={(e) => {
                            const next: Record<string, number> = {};
                            for (const [r, i] of Object.entries(mapping)) if (i !== undefined && i !== index && r !== e.target.value) next[r] = i;
                            if (e.target.value) next[e.target.value] = index;
                            apply({ ...decisions, mapping: next, signConfirmed: false });
                          }}
                        >
                          {Object.entries(ROLE_LABELS).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* --- dates --------------------------------------------------------------- */}
      {view.dateFormat && view.dateFormat.candidates.length > 1 && (
        <div className="card">
          <h2>How are the dates written?</h2>
          <p className="card-sub">
            Every date in this file could be read either way, so you choose — guessing wrong would
            move transactions by months without anything looking off.
          </p>
          <div className="choice-row">
            {view.dateFormat.candidates.map((f) => (
              <label key={f} className="choice">
                <input
                  type="radio"
                  name="date-format"
                  checked={view.dateFormat!.applied === f}
                  disabled={busy}
                  onChange={() => apply({ ...decisions, dateFormat: f })}
                />
                {f === 'MM/DD/YYYY' || f === 'MM/DD/YY' ? 'Month first (US: 03/04 is 4 March)' : f === 'DD/MM/YYYY' || f === 'DD/MM/YY' ? 'Day first (03/04 is 3 April)' : f}
              </label>
            ))}
          </div>
        </div>
      )}

      {/* --- direction: a first-class step (§3.4) --------------------------------- */}
      {sign && (
        <div className="card">
          <h2>Is this the right way round?</h2>
          <p className="card-sub">{sign.evidence}</p>
          {sign.samples.length > 0 && (
            <ul className="sample-list">
              {sign.samples.map((s) => (
                <li key={s.raw}>
                  <span className="raw">{s.raw}</span>
                  <span className="arrow"> → </span>
                  <strong>{s.sentence}</strong>
                </li>
              ))}
            </ul>
          )}
          <div className="form-actions" style={{ marginTop: 12 }}>
            {decisions.signConfirmed ? (
              <span className="positive">Confirmed: these read the right way round.</span>
            ) : (
              <button type="button" className="primary" disabled={busy} onClick={() => apply({ ...decisions, signConfirmed: true })}>
                Yes, that is right
              </button>
            )}
            {!sign.fromColumns && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  apply({
                    ...decisions,
                    signConvention: sign.applied === 'plaid' ? 'inverted' : 'plaid',
                    signConfirmed: false,
                  })
                }
              >
                No — it is the other way round
              </button>
            )}
          </div>
        </div>
      )}

      {/* --- discrepancies: shown, never fixed (§4.4) ------------------------------ */}
      {view.discrepancies.length > 0 && (
        <div className="card">
          <h2>Totals that do not add up</h2>
          <p className="card-sub">
            The statement states these totals, and the rows below add up to something else. Nothing
            has been adjusted to make them agree — that is yours to judge. Usually a row was missed
            or dropped above.
          </p>
          {view.discrepancies.map((d) => (
            <div className="note" key={d.label}>
              <span className="note-tag">Differs</span>
              {d.label}: the statement says <span className="raw">{d.statedRaw}</span> ({d.stated}); the
              rows give {d.computed}
              {d.page ? ` · p.${d.page}` : ''}
            </div>
          ))}
          <label className="choice" style={{ marginTop: 10 }}>
            <input
              type="checkbox"
              checked={Boolean(decisions.discrepanciesAcknowledged)}
              disabled={busy}
              onChange={(e) => apply({ ...decisions, discrepanciesAcknowledged: e.target.checked })}
            />
            I have seen these and want to import anyway
          </label>
        </div>
      )}

      {/* --- balance ----------------------------------------------------------------- */}
      <div className="card">
        <h2>Balance</h2>
        {account.balance ? (
          <p>
            <RawVsShown field={account.balance.current} /> as of <RawVsShown field={account.balance.asOfDate} />
          </p>
        ) : (
          <p className="muted">No balance will be imported. Without one, this account is left out of your totals.</p>
        )}
        <BalanceEditor
          busy={busy}
          hasBalance={Boolean(account.balance)}
          onSave={(amount, asOfDate) => apply({ ...decisions, balanceEdit: { amount, asOfDate } })}
          onRemove={() => apply({ ...decisions, balanceEdit: { remove: true } })}
        />
      </div>

      {/* --- transactions --------------------------------------------------------------- */}
      <div className="card">
        <h2>Transactions</h2>
        <p className="card-sub">
          {account.transactions.length} read, {included} selected. Untick any you do not want.
        </p>
        {account.transactions.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th aria-label="Include" />
                  <th>Date</th>
                  <th>Description</th>
                  <th>As written</th>
                  <th>Read as</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {account.transactions.map((t) => (
                  <tr key={t.row} className={t.include ? '' : 'excluded'}>
                    <td>
                      <input
                        type="checkbox"
                        checked={t.include}
                        disabled={busy}
                        aria-label={`Include row ${t.row}`}
                        onChange={(e) =>
                          apply({ ...decisions, rowEdits: { ...decisions.rowEdits, [t.row]: { ...decisions.rowEdits?.[t.row], include: e.target.checked } } })
                        }
                      />
                    </td>
                    <td className="muted">{t.date.shown}</td>
                    <td>{t.name.shown}</td>
                    <td className="raw">{t.amount.raw}</td>
                    <td>
                      <strong className={t.direction === 'in' ? 'positive' : ''}>
                        {t.magnitude} {t.direction === 'in' ? 'in' : t.direction === 'out' ? 'out' : ''}
                      </strong>{' '}
                      <Origin field={t.amount} />
                    </td>
                    <td>
                      <button type="button" className="link-button" onClick={() => setEditing(editing === t.row ? null : t.row)}>
                        {editing === t.row ? 'Close' : 'Edit'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {editing !== null && (
          <RowEditor
            key={editing}
            row={editing}
            busy={busy}
            current={account.transactions.find((t) => t.row === editing)!}
            onSave={(edit) => {
              apply({ ...decisions, rowEdits: { ...decisions.rowEdits, [editing]: { ...decisions.rowEdits?.[editing], ...edit } } });
              setEditing(null);
            }}
          />
        )}
      </div>

      {account.holdings.length > 0 && (
        <div className="card">
          <h2>Holdings</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Security</th>
                  <th>Quantity</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {account.holdings.map((h, i) => (
                  <tr key={i}>
                    <td>
                      {h.ticker && <span className="tool-name">{h.ticker} </span>}
                      {h.security.shown}
                    </td>
                    <td>
                      <span className="raw">{h.quantity.raw}</span>
                    </td>
                    <td>
                      <RawVsShown field={h.value} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(view.notes.length > 0 || view.unparsed.length > 0) && (
        <div className="card">
          <h2>Worth knowing</h2>
          {view.notes.map((n) => (
            <div className="note" key={n}>
              <span className="note-tag">Note</span>
              {n}
            </div>
          ))}
          {view.unparsed.map((u, i) => (
            <div className="note" key={`${u.where}-${i}`}>
              <span className="note-tag">Not read</span>
              {u.where}
              {u.text ? (
                <>
                  : <span className="raw">{u.text}</span>
                </>
              ) : null}{' '}
              — {u.reason}
            </div>
          ))}
        </div>
      )}

      {/* --- commit and reject, equally prominent ------------------------------------ */}
      <div className="card">
        <div className="form-actions">
          <button type="button" className="primary" disabled={busy || blockers.length > 0} onClick={commit}>
            Import into my records
          </button>
          {confirmReject ? (
            <>
              <span className="muted">Remove this upload? The file is deleted and nothing is imported.</span>
              <button type="button" disabled={busy} onClick={reject}>
                Remove it
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirmReject(false)}>
                Keep reviewing
              </button>
            </>
          ) : (
            <button type="button" disabled={busy} onClick={() => setConfirmReject(true)}>
              Reject this document
            </button>
          )}
          {busy && <span className="faint">Working…</span>}
        </div>
        {error && <p className="error">{error}</p>}
        {reasons.length > 0 && (
          <ul className="checklist">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        <p className="faint" style={{ marginTop: 12 }}>
          <Link href="/import">← All documents</Link>
        </p>
        <NetworkPanel trace={trace} label="What reviewing this cost" />
      </div>
    </div>
  );
}

function BalanceEditor({
  busy,
  hasBalance,
  onSave,
  onRemove,
}: {
  busy: boolean;
  hasBalance: boolean;
  onSave: (amount: string, asOfDate: string) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  if (!open) {
    return (
      <div className="form-actions">
        <button type="button" className="link-button" onClick={() => setOpen(true)}>
          {hasBalance ? 'Correct the balance' : 'Enter a balance'}
        </button>
        {hasBalance && (
          <button type="button" className="link-button" disabled={busy} onClick={onRemove}>
            Do not import a balance
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="form-grid">
      <label htmlFor="bal-amt">Balance</label>
      <input id="bal-amt" inputMode="decimal" value={amount} placeholder="4,182.09 (owed, for a card or loan)" onChange={(e) => setAmount(e.target.value)} />
      <label htmlFor="bal-date">As of</label>
      <input id="bal-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <div className="form-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || amount.trim() === '' || date === ''}
          onClick={() => {
            onSave(amount, date);
            setOpen(false);
          }}
        >
          Use this balance
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function RowEditor({
  row,
  busy,
  current,
  onSave,
}: {
  row: number;
  busy: boolean;
  current: DraftView['accounts'][number]['transactions'][number];
  onSave: (edit: { amount?: string; direction?: 'in' | 'out'; date?: string; name?: string }) => void;
}) {
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'in' | 'out'>(current.direction === 'in' ? 'in' : 'out');
  const [date, setDate] = useState(current.date.shown === '—' ? '' : current.date.shown);
  const [name, setName] = useState(current.name.shown);
  return (
    <div className="form-grid" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <label>Editing row {row}</label>
      <span className="muted">
        The file says <span className="raw">{current.amount.raw}</span>. Edited values are marked as yours.
      </span>
      <label htmlFor="edit-amt">Amount</label>
      <input id="edit-amt" inputMode="decimal" value={amount} placeholder={current.magnitude} onChange={(e) => setAmount(e.target.value)} />
      <label htmlFor="edit-dir">Direction</label>
      <select id="edit-dir" value={direction} onChange={(e) => setDirection(e.target.value as 'in' | 'out')}>
        <option value="out">Money out (spent, paid)</option>
        <option value="in">Money in (received, refunded)</option>
      </select>
      <label htmlFor="edit-date">Date</label>
      <input id="edit-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <label htmlFor="edit-name">Description</label>
      <input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="form-actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() =>
            onSave({
              // Direction alone can change: the amount the server already read is
              // sent back as text (formatted, which parseAmount reads) — still no
              // number is parsed here.
              ...(amount.trim()
                ? { amount, direction }
                : direction !== current.direction
                  ? { amount: current.magnitude, direction }
                  : {}),
              ...(date && date !== current.date.shown ? { date } : {}),
              ...(name.trim() && name !== current.name.shown ? { name } : {}),
            })
          }
        >
          Save row
        </button>
      </div>
    </div>
  );
}
