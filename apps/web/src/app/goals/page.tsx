/**
 * Goals, targets, and notes (§8 Phase 1.5-B/C).
 *
 * Everything on this page reads and writes Postgres only — no Plaid call, so no
 * network cost panel is warranted and none is shown. That is itself the honest
 * signal: pages that cost nothing should not imply they did.
 *
 * This is where the spend target graduates to now that it has company. It still
 * appears on the summary's FIRE card, because that is where its absence is felt.
 */

import { type UserContextData, formatCents, getUserContext } from '@pfg/core';
import { requireCtx } from '@/server/auth';
import { FigureEvidence } from '../Evidence';
import { SpendTarget } from '../SpendTarget';
import { AddGoalForm, AddNoteForm, DeleteGoalButton } from './GoalForms';

export const dynamic = 'force-dynamic';

const GOAL_TYPE_LABELS: Record<string, string> = {
  fire: 'Financial independence',
  emergency_fund: 'Emergency fund',
  debt_payoff: 'Debt payoff',
  savings_target: 'Savings target',
  custom: 'Custom',
};

export default async function GoalsPage() {
  const ctx = await requireCtx();
  const context = await getUserContext(ctx);
  const data: UserContextData = context.data;

  return (
    <div className="stack">
      <div className="card">
        <h2>Your spending target</h2>
        <p className="card-sub">
          The one figure the FIRE calculation cannot run without. It is what you expect to
          spend in a year, not what you currently spend — the app does not measure it for you.
        </p>
        <SpendTarget
          current={
            data.targetAnnualSpendCents !== null
              ? formatCents(data.targetAnnualSpendCents)
              : undefined
          }
        />
      </div>

      <div className="card">
        <h2>Goals</h2>
        <p className="card-sub">
          Goals are yours to track. Jolly reads them for context — it does not police them.
        </p>

        {data.goals.length === 0 ? (
          <p className="muted">No goals yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Goal</th>
                  <th>Type</th>
                  <th style={{ textAlign: 'right' }}>Target</th>
                  <th>By</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.goals.map((goal) => (
                  <tr key={goal.id}>
                    <td>{goal.label ?? GOAL_TYPE_LABELS[goal.type] ?? goal.type}</td>
                    <td className="muted">{GOAL_TYPE_LABELS[goal.type] ?? goal.type}</td>
                    <td className="num">
                      {goal.targetCents !== null ? formatCents(goal.targetCents) : '—'}
                    </td>
                    <td className="muted">{goal.targetDate ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <DeleteGoalButton goalId={goal.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <AddGoalForm />
        </div>
      </div>

      <div className="card">
        <h2>Notes</h2>
        <p className="card-sub">
          Context in your own words. These are the only free-text values the app stores, and
          they are yours — nothing here comes from Plaid.
        </p>

        {data.notes.length === 0 ? (
          <p className="muted">No notes yet.</p>
        ) : (
          <ul className="note-list">
            {data.notes.map((note) => (
              <li key={note.id}>
                <span className="faint">{new Date(note.createdAt).toLocaleDateString()}</span>{' '}
                {note.text}
              </li>
            ))}
          </ul>
        )}

        <AddNoteForm />
      </div>

      <div className="card">
        <h2>Income and risk</h2>
        <p className="card-sub">
          {data.annualIncomeCents !== null
            ? `Recorded income: ${formatCents(data.annualIncomeCents)}.`
            : 'No income recorded.'}{' '}
          {data.riskTolerance ? `Risk tolerance: ${data.riskTolerance}.` : ''}
        </p>
        {/*
          Stated plainly rather than presented as a working input. Neither field
          is read by any compute function today — see docs/STATE.md. Showing them
          as if they drove a calculation would be the kind of quiet overstatement
          §0.2 exists to prevent.
        */}
        <div className="note">
          <span className="note-tag">Caveat</span>
          These are stored for context and are read by Jolly when answering, but no
          calculation currently uses them. Only the spending target above feeds a figure.
        </div>
        <FigureEvidence
          entry={{ tool: 'getUserContext', params: {}, data: null, provenance: context.provenance }}
          label="Where this came from"
        />
      </div>
    </div>
  );
}
