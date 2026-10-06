/**
 * Shared error handling for route handlers.
 *
 * Two rules, both §9-driven:
 *
 * 1. The client gets a fixed, human-readable message. Internal error text can
 *    carry account names, Plaid item ids, or SQL fragments; none of that should
 *    reach a browser just because something threw.
 * 2. The detail goes to the server log instead — but errors from the Plaid path
 *    can quote request bodies, so nothing here logs an object it has not
 *    inspected. We log `message` and `name`, never the whole error.
 */

import { UnauthenticatedError } from './auth';
import {
  ManualLedgerError,
  MissingDatabaseError,
  MissingSnapshotError,
  SnapshotOwnershipError,
  UnknownWorkflowError,
} from '@pfg/core';
import { CommitBlockedError, DocumentNotFoundError, StorageKeyError, UploadRejectedError } from '@pfg/ingest';
import { NextResponse } from 'next/server';

export function errorResponse(error: unknown, clientMessage: string): NextResponse {
  const name = error instanceof Error ? error.name : 'Error';
  const detail = error instanceof Error ? error.message : String(error);

  if (error instanceof UnauthenticatedError) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  // Cross-user leakage would be the worst bug this codebase could have
  // (§ packages/core/src/context.ts). If the ownership check ever fires it is a
  // bug in our plumbing, not a user error — make it loud in the log.
  if (error instanceof SnapshotOwnershipError) {
    console.error('[isolation] snapshot/ctx user mismatch — refusing to respond.', detail);
    return NextResponse.json({ error: clientMessage }, { status: 500 });
  }

  // Validation errors from the manual ledger are written for a person and carry
  // nothing but what they typed — safe to return as-is, and far more useful
  // than a generic message when the fix is "that date is in the future".
  if (error instanceof ManualLedgerError) {
    return NextResponse.json({ error: detail }, { status: 400 });
  }

  // Import outcomes written for a person. None of them carries file content:
  // a rejection names the kind of file, a blocker names what to do next.
  if (error instanceof UploadRejectedError) {
    return NextResponse.json({ error: detail }, { status: 400 });
  }
  if (error instanceof CommitBlockedError) {
    return NextResponse.json({ error: 'This import is not ready yet.', reasons: error.reasons }, { status: 400 });
  }
  if (error instanceof DocumentNotFoundError) {
    return NextResponse.json({ error: 'No such document.' }, { status: 404 });
  }
  if (error instanceof StorageKeyError) {
    console.error('[isolation] document storage key refused:', detail);
    return NextResponse.json({ error: clientMessage }, { status: 500 });
  }

  if (error instanceof UnknownWorkflowError) {
    return NextResponse.json({ error: clientMessage }, { status: 422 });
  }

  if (error instanceof MissingSnapshotError || error instanceof MissingDatabaseError) {
    console.error(`[wiring] ${name}: ${detail}`);
    return NextResponse.json({ error: clientMessage }, { status: 500 });
  }

  console.error(`[route] ${name}: ${detail}`);
  return NextResponse.json({ error: clientMessage }, { status: 500 });
}
