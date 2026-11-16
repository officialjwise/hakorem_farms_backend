import type { Server } from 'node:http';
import type { ManualClock } from '@hakorem/kernel';
import { expect } from 'vitest';
import { totpAt } from '../../src/modules/iam/domain/totp';
import { consolePost, type TestSession } from './iam';
import type { TestDatabase } from './test-database';

export type TotpSession = TestSession & { readonly secret: Buffer };

/** A line of a manual journal as the API takes it. */
export interface JournalLineInput {
  readonly accountId: string;
  readonly side: 'D' | 'C';
  readonly amountPesewas: number;
  readonly subledgerPartyId?: string;
  readonly memo?: string;
}

/** A fresh step-up for the session: half a minute later, so each code is a new TOTP step. */
export async function stepUp(server: Server, session: TotpSession, clock: ManualClock): Promise<void> {
  clock.advanceBy(30_000);
  const code = totpAt(session.secret, Math.floor(clock.now().getTime() / 1000));
  const response = await consolePost(server, session, '/v1/auth/step-up').send({ code });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

/**
 * Posts a manual journal the way the farm does (FR-FIN-008): the maker drafts and submits it, a different person
 * approves it with step-up, and the ledger posts it. Returns the manual journal's id.
 */
export async function postManualJournal(
  server: Server,
  clock: ManualClock,
  people: { readonly maker: TestSession; readonly checker: TotpSession },
  journal: { readonly kind?: 'MANUAL' | 'OPENING'; readonly postingDate: string; readonly description: string; readonly lines: readonly JournalLineInput[] },
): Promise<string> {
  const created = await consolePost(server, people.maker, '/v1/finance/manual-journals').send({ kind: 'MANUAL', ...journal });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const submitted = await consolePost(server, people.maker, `/v1/finance/manual-journals/${created.body.id as string}/submit`).send({});
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
  await stepUp(server, people.checker, clock);
  const approved = await consolePost(server, people.checker, `/v1/iam/approvals/${submitted.body.approvalRequestId as string}/approve`).send({ reason: 'Checked against the source documents' });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return created.body.id as string;
}

/** Account ids by code, and the bank account parties by bank account name, read once from the database. */
export async function ledgerIds(database: TestDatabase): Promise<{ readonly account: (code: string) => string; readonly bankParty: (name: string) => string }> {
  const accounts = new Map((await database.pool('admin').query<{ code: string; id: string }>('SELECT code, id FROM fin.account')).rows.map((r) => [r.code, r.id] as const));
  const parties = new Map(
    (
      await database.pool('admin').query<{ name: string; id: string }>(
        "SELECT b.name, s.id FROM fin.bank_account b JOIN fin.subledger_party s ON s.kind = 'BANK_ACCOUNT' AND s.ref_id = b.id",
      )
    ).rows.map((r) => [r.name, r.id] as const),
  );
  return { account: (code) => accounts.get(code)!, bankParty: (name) => parties.get(name)! };
}
