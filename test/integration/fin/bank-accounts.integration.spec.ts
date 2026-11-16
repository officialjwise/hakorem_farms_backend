import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountNoBinding, accountNoPlace } from '../../../src/modules/fin/application/bank-accounts';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import type { KeyRing } from '../../../src/platform/crypto/key-ring';
import { openWithOwnKey } from '../../../src/platform/crypto/value-keys';
import { requestHash } from '../../../src/platform/idempotency/idempotency';
import { KEY_RING } from '../../../src/platform/platform.module';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The business's own bank accounts and wallets over the seeded farm (B08 continued 1b2 gate, ADR-0057, A-193, A-194):
 * every operation refused to the wrong role; adding one needs a fresh step-up; the number is stored only sealed with a
 * data key of its own and leaves FIN only as its last four digits, in no response, log line, audit row, outbox message,
 * idempotency record or error, and nowhere in the database in clear; the database keeps the number and the GL account
 * and gives each account its own subledger party. The supplier payment's account is
 * test/integration/pur/supplier-payment-bank-account.integration.spec.ts.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
type TotpSession = TestSession & { readonly secret: Buffer };
const sessions = new Map<string, TestSession>();
const ids = new Map<string, string>();
/** Every number this file types, in each form it could leak in. */
const GCB_NO = '2040016620';
const MOMO_NO = '+233244127310';
const SECRETS = [GCB_NO, '2040-0166 20', MOMO_NO, '0244127310', '244127310', '9900112233445', '0244998877'];
/** Every response body this file receives, searched at the end. */
const bodies: string[] = [];

const remember = <T extends { text: string }>(response: T): T => {
  bodies.push(response.text);
  return response;
};
const get = async (who: string, path: string) => remember(await consoleGet(api.server, sessions.get(who)!, `/v1${path}`));
const post = async (who: string, path: string, body: object = {}, key: string = randomUUID()) => remember(await consolePost(api.server, sessions.get(who)!, `/v1${path}`, key).send(body));
const patch = async (who: string, path: string, body: object, key: string = randomUUID()) => {
  const session = sessions.get(who)!;
  return remember(await request(api.server).patch(`/v1${path}`).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key).send(body));
};
const admin = () => database.pool('admin');
const app = () => database.pool('app');
const id = (code: string) => ids.get(code)!;

async function stepUp(who: string): Promise<void> {
  clock.advanceBy(30_000);
  const session = sessions.get(who) as TotpSession;
  expect((await post(who, '/auth/step-up', { code: totpAt(session.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
}

const gcb = { kind: 'BANK', name: 'GCB current account', institution: 'GCB Bank', accountNo: '2040-0166 20' };
const momo = { kind: 'MOBILE_MONEY', name: 'MTN MoMo merchant wallet', institution: 'MTN Mobile Money', accountNo: '024 412 7310' };

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'supplier:' || name, id FROM mdm.supplier
       UNION ALL SELECT 'tax:' || code, id FROM mdm.tax_category`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  const people: [string, string, 'OWNER' | 'ACCOUNTANT' | 'MANAGER' | 'STOREKEEPER' | 'CASHIER' | 'SALES' | 'FARM_HAND' | 'DRIVER' | 'INVESTOR', boolean][] = [
    ['owner', 'Kwabena Owusu', 'OWNER', true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true],
    ['manager', 'Akosua Boateng', 'MANAGER', true],
    ['storekeeper', 'Kwesi Ofori', 'STOREKEEPER', false],
    ['cashier', 'Adwoa Darko', 'CASHIER', false],
    ['sales', 'Esi Appiah', 'SALES', false],
    ['farmHand', 'Abdul-Rahman Iddrisu', 'FARM_HAND', false],
    ['driver', 'Selorm Agbeko', 'DRIVER', false],
    ['investor', 'Nana Ama Ofori', 'INVESTOR', false],
  ];
  for (const [who, name, role, privileged] of people) {
    const user = await createUser(database, { name, grants: [{ role, branchId }] });
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('every bank account operation refuses the wrong role (ADR-0017, ADR-0035)', () => {
  it('refuses listing, adding and changing to the Manager, Storekeeper, Cashier, Sales, Farm hand, Driver and Investor', async () => {
    for (const who of ['manager', 'storekeeper', 'cashier', 'sales', 'farmHand', 'driver', 'investor']) {
      expect((await get(who, '/finance/bank-accounts')).status, who).toBe(403);
      expect((await post(who, '/finance/bank-accounts', { ...gcb, name: `Refused ${who}` })).status, who).toBe(403);
      expect((await patch(who, `/finance/bank-accounts/${randomUUID()}`, { version: 1, isActive: false })).status, who).toBe(403);
    }
    const { rows } = await admin().query<{ n: number }>("SELECT count(*)::int AS n FROM fin.bank_account WHERE name LIKE 'Refused %'");
    expect(rows[0]!.n).toBe(0);
  });
});

describe('adding an account (ADR-0057, A-194)', () => {
  it('seals a bank number, answers only its last four digits, posts it to 1100 against its own party, once per key', async () => {
    await stepUp('owner');
    const key = randomUUID();
    const created = await post('owner', '/finance/bank-accounts', gcb, key);
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: expect.any(String),
      kind: 'BANK',
      name: 'GCB current account',
      institution: 'GCB Bank',
      accountNoLast4: '6620',
      glAccount: { id: '01900000-0000-7000-8100-000000001100', code: '1100', name: 'Bank accounts' },
      branch: null,
      isActive: true,
      version: 1,
    });
    ids.set('bank:GCB', created.body.id);
    const replay = await post('owner', '/finance/bank-accounts', gcb, key);
    expect([replay.status, replay.body]).toEqual([201, created.body]);
    const reused = await post('owner', '/finance/bank-accounts', { ...gcb, accountNo: '9900112233445' }, key);
    expect([reused.status, reused.body.error.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
    const { rows } = await admin().query<{ account_no_enc: Buffer; account_no_data_key: Buffer; account_no_kek_version: number; party: string; n: number }>(
      `SELECT b.account_no_enc, b.account_no_data_key, b.account_no_kek_version, p.kind || ':' || p.display_name AS party,
              (SELECT count(*)::int FROM fin.bank_account WHERE name = 'GCB current account') AS n
         FROM fin.bank_account b JOIN fin.subledger_party p ON p.ref_id = b.id AND p.kind = 'BANK_ACCOUNT' WHERE b.id = $1`,
      [created.body.id],
    );
    expect(rows[0]!.n).toBe(1);
    expect(rows[0]!.party).toBe('BANK_ACCOUNT:GCB current account');
    expect(rows[0]!.account_no_enc.includes(Buffer.from(GCB_NO))).toBe(false);
    const sealed = { ciphertext: rows[0]!.account_no_enc, wrappedKey: rows[0]!.account_no_data_key, kekVersion: rows[0]!.account_no_kek_version };
    const keyRing = api.app.get<KeyRing>(KEY_RING);
    expect(openWithOwnKey(keyRing, sealed, accountNoPlace(created.body.id), accountNoBinding(created.body.id))).toBe(GCB_NO);
    // The idempotency record hashes a keyed digest of the number, not the number, so the hash cannot be reversed.
    const stored = await admin().query<{ request_hash: Buffer }>("SELECT request_hash FROM platform.idempotency_key WHERE key = $1 AND scope LIKE '%:createBankAccount'", [key]);
    expect(stored.rows[0]!.request_hash.equals(requestHash(gcb))).toBe(false);
  });

  it('keeps a wallet number as +233 and nine digits and posts it to 1110', async () => {
    const created = await post('owner', '/finance/bank-accounts', momo);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: 'MOBILE_MONEY', accountNoLast4: '7310', glAccount: { code: '1110', name: 'Mobile money wallets' } });
    ids.set('bank:MOMO', created.body.id);
    const { rows } = await admin().query<{ account_no_enc: Buffer; account_no_data_key: Buffer; account_no_kek_version: number }>(
      'SELECT account_no_enc, account_no_data_key, account_no_kek_version FROM fin.bank_account WHERE id = $1',
      [created.body.id],
    );
    const sealed = { ciphertext: rows[0]!.account_no_enc, wrappedKey: rows[0]!.account_no_data_key, kekVersion: rows[0]!.account_no_kek_version };
    expect(openWithOwnKey(api.app.get<KeyRing>(KEY_RING), sealed, accountNoPlace(created.body.id), accountNoBinding(created.body.id))).toBe(MOMO_NO);
  });

  it('refuses a malformed number, a name in use and an unknown branch, naming the rule and never the number', async () => {
    await stepUp('accountant');
    const refusals: [object, number, string, string | undefined][] = [
      [{ ...gcb, name: 'Short', accountNo: '12345' }, 422, 'BANK_ACCOUNT_INVALID', 'ACCOUNT_NUMBER_INVALID'],
      [{ ...momo, name: 'Not a wallet', accountNo: '9900112233445' }, 422, 'BANK_ACCOUNT_INVALID', 'MOMO_NUMBER_INVALID'],
      [{ ...gcb, name: ' gcb current ACCOUNT ', accountNo: '9900112233445' }, 422, 'BANK_ACCOUNT_INVALID', 'NAME_TAKEN'],
      [{ ...gcb, name: 'Branch account', accountNo: '9900112233445', branchId: randomUUID() }, 422, 'REFERENCE_NOT_FOUND', 'UNKNOWN'],
      [{ ...gcb, name: 'Chosen ledger', accountNo: '9900112233445', glAccountId: randomUUID() }, 400, 'VALIDATION_FAILED', 'UNKNOWN_FIELD'],
      [{ ...momo, name: 'Long', accountNo: '0244998877'.repeat(5) }, 400, 'VALIDATION_FAILED', 'TOO_BIG'],
    ];
    for (const [body, status, code, detail] of refusals) {
      const refused = await post('accountant', '/finance/bank-accounts', body);
      expect([refused.status, refused.body.error.code, refused.body.error.details[0].code], JSON.stringify(body)).toEqual([status, code, detail]);
      expect(typeof refused.body.error.correlationId).toBe('string');
    }
  });

  it('lists the accounts by name, each as its last four digits, paging without skipping or repeating', async () => {
    const seen: { name: string; accountNoLast4: string }[] = [];
    let cursor: string | null = null;
    do {
      const page = await get('accountant', `/finance/bank-accounts?limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
      expect(page.status).toBe(200);
      seen.push(...(page.body.data as { name: string; accountNoLast4: string }[]));
      cursor = page.body.page.nextCursor as string | null;
    } while (cursor !== null);
    expect(seen.map((a) => [a.name, a.accountNoLast4])).toEqual([
      ['GCB current account', '6620'],
      ['GCB current account (SEED)', '0101'],
      ['MTN MoMo merchant wallet', '7310'],
      ['MTN MoMo merchant wallet (SEED)', '0101'],
    ]);
  });
});

describe('changing an account (A-194)', () => {
  it('renames and deactivates at its version, audited before and after, and refuses a stale version and a name in use', async () => {
    await stepUp('accountant');
    const path = `/finance/bank-accounts/${id('bank:MOMO')}`;
    const renamed = await patch('accountant', path, { version: 1, name: 'MTN MoMo merchant wallet, Dodowa' });
    expect(renamed.body).toMatchObject({ name: 'MTN MoMo merchant wallet, Dodowa', version: 2, isActive: true, accountNoLast4: '7310' });
    expect((await patch('accountant', path, { version: 1, isActive: false })).body.error.code).toBe('VERSION_CONFLICT');
    const taken = await patch('accountant', path, { version: 2, name: 'GCB current account' });
    expect([taken.status, taken.body.error.details[0].code]).toEqual([422, 'NAME_TAKEN']);
    expect((await patch('accountant', `/finance/bank-accounts/${randomUUID()}`, { version: 1, isActive: false })).status).toBe(404);
    const audit = await admin().query<{ action: string; before: unknown; after: unknown }>(
      `SELECT action, convert_from("before", 'UTF8')::jsonb AS "before", convert_from("after", 'UTF8')::jsonb AS "after" FROM platform.audit_event WHERE entity_type = 'BankAccount' AND entity_id = $1 ORDER BY occurred_at, id`,
      [id('bank:MOMO')],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['CREATE', 'UPDATE']);
    expect(audit.rows[1]).toMatchObject({ before: { name: 'MTN MoMo merchant wallet', isActive: true, version: 1 }, after: { name: 'MTN MoMo merchant wallet, Dodowa', isActive: true, version: 2 } });
    expect(audit.rows[0]!.after).toMatchObject({ accountNoLast4: '7310', glAccount: { code: '1110' } });
  });

  it('keeps the kind, the sealed number, its last four digits and the GL account, and never removes an account, whoever writes', async () => {
    const refusal = (sql: string, values: unknown[] = [id('bank:GCB')]) =>
      app()
        .query(sql, values)
        .then(
          () => undefined,
          (error: { code?: string; constraint?: string }) => [error.code, error.constraint],
        );
    const change = ['HK012', 'ck_bank_account_change'];
    expect(await refusal("UPDATE fin.bank_account SET account_no_last4 = '0000' WHERE id = $1")).toEqual(change);
    expect(await refusal("UPDATE fin.bank_account SET kind = 'MOBILE_MONEY' WHERE id = $1")).toEqual(change);
    expect(await refusal("UPDATE fin.bank_account SET account_no_enc = decode(repeat('00', 40), 'hex') WHERE id = $1")).toEqual(change);
    expect(await refusal("UPDATE fin.bank_account SET account_no_data_key = decode(repeat('00', 61), 'hex') WHERE id = $1")).toEqual(change);
    expect(await refusal('UPDATE fin.bank_account SET gl_account_id = $2 WHERE id = $1', [id('bank:GCB'), '01900000-0000-7000-8100-000000001110'])).toEqual(change);
    expect(await refusal("UPDATE fin.bank_account SET deleted_at = now(), deleted_by = created_by, delete_reason = 'gone' WHERE id = $1")).toEqual(change);
    expect(await sqlStateOf(app().query('DELETE FROM fin.bank_account WHERE id = $1', [id('bank:GCB')]))).toBe(SQLSTATE.insufficientPrivilege);
  });

  it('refuses an account on the wrong control account, and one without its own party at commit', async () => {
    const insert = (kind: string, glCode: string) =>
      `INSERT INTO fin.bank_account (id, kind, name, institution, account_no_enc, account_no_data_key, account_no_kek_version, account_no_last4, gl_account_id, created_by, updated_by)
       VALUES ('${randomUUID()}', '${kind}', 'Raw ${randomUUID()}', 'Raw', decode(repeat('01', 40), 'hex'), decode(repeat('02', 61), 'hex'), 1, '0001',
               '01900000-0000-7000-8100-00000000${glCode}', '${SYSTEM_PRINCIPAL}', '${SYSTEM_PRINCIPAL}')`;
    const failed = (sql: string) =>
      app()
        .query(sql)
        .then(
          () => undefined,
          (error: { code?: string; constraint?: string }) => [error.code, error.constraint],
        );
    expect(await failed(insert('BANK', '1110'))).toEqual(['HK012', 'ck_bank_account_gl']);
    expect(await failed(insert('MOBILE_MONEY', '1100'))).toEqual(['HK012', 'ck_bank_account_gl']);
    expect(await failed(insert('BANK', '1010'))).toEqual(['HK012', 'ck_bank_account_gl']);
    expect(await failed(insert('BANK', '1100'))).toEqual(['HK012', 'ck_bank_account_party']);
  });
});

describe('the full number never leaves FIN (ADR-0057, DC-40)', () => {
  it('appears in no response, log line, audit row, outbox message, idempotency record, nor anywhere in the database in clear', async () => {
    const leaks = (text: string) => SECRETS.filter((secret) => text.includes(secret));
    expect(bodies.length).toBeGreaterThan(30);
    expect(bodies.flatMap(leaks)).toEqual([]);
    expect(leaks(JSON.stringify(api.logLines()))).toEqual([]);
    const { rows: tables } = await admin().query<{ name: string }>(
      `SELECT format('%I.%I', table_schema, table_name) AS name FROM information_schema.tables
        WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`,
    );
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['platform.audit_event', 'platform.outbox_message', 'platform.idempotency_key', 'fin.bank_account']));
    const found: string[] = [];
    for (const table of tables) {
      for (const secret of SECRETS) {
        // A bytea column (the audit trail's before and after) shows as hex in a row's text, so search both forms.
        const { rows } = await admin().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table.name} t WHERE t::text LIKE '%' || $1 || '%' OR t::text LIKE '%' || encode(convert_to($1, 'UTF8'), 'hex') || '%'`,
          [secret],
        );
        if (rows[0]!.n > 0) found.push(`${table.name}: ${secret}`);
      }
    }
    expect(found).toEqual([]);
  });
});

describe('adding needs a fresh step-up (FR-IAM-007, ADR-0057)', () => {
  it('refuses an Accountant whose step-up is older than five minutes, and adds nothing', async () => {
    const user = await createUser(database, { name: 'Efua Mensah', grants: [{ role: 'ACCOUNTANT', branchId: id('branch:DDW') }] });
    sessions.set('lateAccountant', await enrolAndLogin(api.server, user, () => clock.now()));
    await stepUp('lateAccountant');
    clock.advanceBy(301_000);
    const stale = await post('lateAccountant', '/finance/bank-accounts', { ...gcb, name: 'Stale step-up', accountNo: '9900112233445' });
    expect([stale.status, stale.body.error.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    const renamed = await patch('lateAccountant', `/finance/bank-accounts/${id('bank:GCB')}`, { version: 1, name: 'Stale rename' });
    expect([renamed.status, renamed.body.error.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    const { rows } = await admin().query<{ n: number }>("SELECT count(*)::int AS n FROM fin.bank_account WHERE name IN ('Stale step-up', 'Stale rename')");
    expect(rows[0]!.n).toBe(0);
  });
});
