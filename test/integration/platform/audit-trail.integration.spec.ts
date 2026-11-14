import { randomBytes, randomUUID } from 'node:crypto';
import { systemClock } from '@hakorem/kernel';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditFieldPlace, AuditTrail, type EncryptedField } from '../../../src/platform/audit/audit-trail';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { KeyRing } from '../../../src/platform/crypto/key-ring';
import { openWithSubjectKey, SubjectKeys } from '../../../src/platform/crypto/subject-keys';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const SYSTEM = { principalId: '01900000-0000-7000-8000-000000000001', displayName: 'System' };
let database: TestDatabase;
let uow: UnitOfWork;
let keys: SubjectKeys;
let audit: AuditTrail;

beforeAll(async () => {
  database = await createTestDatabase();
  uow = new UnitOfWork(database.pool('app'), pino({ level: 'silent' }));
  keys = new SubjectKeys(new KeyRing(new Map([[1, randomBytes(32)]]), 1), systemClock);
  audit = new AuditTrail(keys, systemClock, database.pool('app'));
});

afterAll(async () => {
  await database.drop();
});

const asSystem = <T>(fn: () => Promise<T>) => runAsSystem(SYSTEM, randomUUID(), fn);

async function storedAfter(id: string): Promise<Record<string, unknown>> {
  const { rows } = await database.pool('admin').query<{ after: Buffer }>('SELECT "after" FROM platform.audit_event WHERE id = $1', [id]);
  return JSON.parse(rows[0]!.after.toString('utf8')) as Record<string, unknown>;
}

describe('the audit trail (ADR-0006, ADR-0022)', () => {
  it('commits a business change and its audit row together, or neither', async () => {
    await database.pool('admin').query('CREATE TABLE platform.audit_probe (id uuid PRIMARY KEY)');
    await database.pool('admin').query('GRANT SELECT, INSERT ON platform.audit_probe TO hk_app');
    const committed = randomUUID();
    const eventId = await asSystem(() =>
      uow.run({ isolation: 'serializable' }, async (tx) => {
        await tx.query('INSERT INTO platform.audit_probe (id) VALUES ($1)', [committed]);
        return audit.record(tx, { module: 'mdm', action: 'CREATE', entityType: 'Probe', entityId: committed, after: { id: committed } });
      }),
    );
    const rolledBack = randomUUID();
    let rolledBackEvent = '';
    await expect(
      asSystem(() =>
        uow.run({ isolation: 'serializable' }, async (tx) => {
          await tx.query('INSERT INTO platform.audit_probe (id) VALUES ($1)', [rolledBack]);
          rolledBackEvent = await audit.record(tx, { module: 'mdm', action: 'CREATE', entityType: 'Probe', entityId: rolledBack });
          throw new Error('the business rule refused it after the audit row was written');
        }),
      ),
    ).rejects.toThrow('refused');
    const admin = database.pool('admin');
    expect((await admin.query('SELECT 1 FROM platform.audit_event WHERE id = $1', [eventId])).rowCount).toBe(1);
    expect((await admin.query('SELECT 1 FROM platform.audit_probe WHERE id = $1', [rolledBack])).rowCount).toBe(0);
    expect((await admin.query('SELECT 1 FROM platform.audit_event WHERE id = $1', [rolledBackEvent])).rowCount).toBe(0);
  });

  it('records actor, correlation id and before and after values, and never a secret field', async () => {
    const id = await asSystem(() =>
      uow.run({ isolation: 'serializable' }, (tx) =>
        audit.record(tx, {
          module: 'iam',
          action: 'UPDATE',
          entityType: 'UserAccount',
          before: { displayName: 'Yaw Boateng', passwordHash: '$argon2id$v=19$abc', totpSecret: 'JBSWY3DPEHPK3PXP' },
          after: { displayName: 'Yaw Boateng', nested: { refreshToken: 'opaque-token', apiKey: 'hk_live_abc.def', pin: '4821' } },
          metadata: { csrfToken: 'c3f1a0', reason: 'Name corrected' },
        }),
      ),
    );
    const { rows } = await database.pool('admin').query<{ before: Buffer; after: Buffer; metadata: unknown; actor_id: string; correlation_id: string }>(
      'SELECT "before", "after", metadata, actor_id, correlation_id FROM platform.audit_event WHERE id = $1',
      [id],
    );
    const text = `${rows[0]!.before.toString('utf8')} ${rows[0]!.after.toString('utf8')} ${JSON.stringify(rows[0]!.metadata)}`;
    for (const secret of ['$argon2id', 'JBSWY3DPEHPK3PXP', 'opaque-token', 'hk_live_abc', '4821', 'c3f1a0']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('Name corrected');
    expect(rows[0]!.actor_id).toBe(SYSTEM.principalId);
    expect(rows[0]!.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("encrypts a subject's personal fields with that subject's key; destroying the key leaves the row and its hash intact but unreadable", async () => {
    const customer = { type: 'CUSTOMER' as const, id: randomUUID() };
    const id = await asSystem(() =>
      uow.run({ isolation: 'serializable' }, (tx) =>
        audit.record(tx, {
          module: 'mdm',
          action: 'UPDATE',
          entityType: 'Customer',
          entityId: customer.id,
          before: { phone: '+233244512876', tier: 'RETAIL' },
          after: { phone: '+233201234567', tier: 'WHOLESALE' },
          subject: customer,
          personalFields: ['phone'],
        }),
      ),
    );
    const after = await storedAfter(id);
    expect(after['tier']).toBe('WHOLESALE');
    expect(JSON.stringify(after)).not.toContain('+233201234567');
    const encrypted = Buffer.from((after['phone'] as EncryptedField).$enc, 'base64');

    const { rows } = await database.pool('admin').query<{ subject_key_id: string; hash_ok: boolean }>(
      'SELECT subject_key_id, content_hash = platform.audit_event_content_hash(e) AS hash_ok FROM platform.audit_event e WHERE id = $1',
      [id],
    );
    const keyId = rows[0]!.subject_key_id;
    const key = await uow.run({ isolation: 'read committed' }, (tx) => keys.keyById(tx, keyId));
    expect(JSON.parse(openWithSubjectKey(key!, encrypted, auditFieldPlace(id, 'after', 'phone')))).toBe('+233201234567');
    expect(rows[0]!.hash_ok).toBe(true);

    await uow.run({ isolation: 'serializable' }, (tx) => keys.destroy(tx, customer, SYSTEM.principalId, 'Data deletion request DSR-0007'));
    expect(await uow.run({ isolation: 'read committed' }, (tx) => keys.keyById(tx, keyId))).toBeNull();
    const after2 = await storedAfter(id);
    expect(after2).toEqual(after);
    const { rows: still } = await database
      .pool('admin')
      .query<{ hash_ok: boolean }>('SELECT content_hash = platform.audit_event_content_hash(e) AS hash_ok FROM platform.audit_event e WHERE id = $1', [id]);
    expect(still[0]!.hash_ok).toBe(true);
  });

  it('refuses to store new personal data for a subject whose key was destroyed', async () => {
    const investor = { type: 'INVESTOR' as const, id: randomUUID() };
    await asSystem(() =>
      uow.run({ isolation: 'serializable' }, async (tx) => {
        await keys.keyFor(tx, investor, SYSTEM.principalId);
        await keys.destroy(tx, investor, SYSTEM.principalId, 'Deletion request');
      }),
    );
    await expect(
      asSystem(() =>
        uow.run({ isolation: 'serializable' }, (tx) =>
          audit.record(tx, { module: 'cap', action: 'UPDATE', entityType: 'Investor', after: { name: 'Esi Bonsu' }, subject: investor, personalFields: ['name'] }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'SUBJECT_ERASED' });
  });

  it('takes twenty parallel audited writes without a serialization failure caused by auditing', async () => {
    let retries = 0;
    const counting = new UnitOfWork(database.pool('app'), {
      ...pino({ level: 'silent' }),
      warn: () => {
        retries += 1;
      },
    } as unknown as pino.Logger);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        asSystem(() =>
          counting.run({ isolation: 'serializable' }, (tx) =>
            audit.record(tx, { module: 'inv', action: 'CREATE', entityType: 'Probe', entityId: randomUUID(), after: { index } }),
          ),
        ),
      ),
    );
    expect(retries).toBe(0);
  });
});
