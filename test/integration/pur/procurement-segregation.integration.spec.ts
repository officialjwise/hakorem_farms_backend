import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The procurement grants after the owner's answer of 2026-11-15 (A-169, A-171). The rule is held per person, not per
 * role: payout changes are cross-approved (the Owner's by a Manager or an Accountant, theirs by the Owner), maker and
 * checker always differ, and the person who made a payout change never approves the first payment after it
 * (`test/integration/pur/supplier-register.integration.spec.ts`). What stays role-level, read from the grants the
 * migrations write: no role outside the Owner, the Manager and the Accountant holds any payout permission, and so none
 * outside them holds a payout permission together with a payment permission.
 */
const PAYOUT_SIDE = ['pur.supplier.payout_change', 'pur.supplier.payout_approve'];
const PAYMENT_SIDE = ['pur.supplier_payment.create', 'pur.supplier_payment.approve', 'pur.supplier_payment.pay'];

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe('procurement segregation of duties (owner, 2026-11-15)', () => {
  it('grants no role but the Owner, the Manager and the Accountant both a payout detail permission and a supplier payment permission', async () => {
    const { rows } = await database.pool('admin').query<{ role: string }>(
      `SELECT r.code AS role
         FROM iam.role r JOIN iam.role_permission rp ON rp.role_id = r.id
        WHERE r.deleted_at IS NULL
        GROUP BY r.code
       HAVING bool_or(rp.permission_code = ANY($1::text[])) AND bool_or(rp.permission_code = ANY($2::text[]))
        ORDER BY r.code`,
      [PAYOUT_SIDE, PAYMENT_SIDE],
    );
    expect(rows.map((r) => r.role)).toEqual(['ACCOUNTANT', 'MANAGER', 'OWNER']);
  });

  it('grants the payout permissions so that each of the three can make a change one of the others approves', async () => {
    const { rows } = await database.pool('admin').query<{ permission_code: string; roles: string[] }>(
      `SELECT rp.permission_code, array_agg(r.code ORDER BY r.code) AS roles
         FROM iam.role_permission rp JOIN iam.role r ON r.id = rp.role_id
        WHERE r.deleted_at IS NULL AND rp.permission_code = ANY($1::text[])
        GROUP BY rp.permission_code ORDER BY rp.permission_code`,
      [[...PAYOUT_SIDE, ...PAYMENT_SIDE]],
    );
    expect(Object.fromEntries(rows.map((r) => [r.permission_code, r.roles]))).toEqual({
      'pur.supplier.payout_approve': ['ACCOUNTANT', 'MANAGER', 'OWNER'],
      'pur.supplier.payout_change': ['ACCOUNTANT', 'MANAGER', 'OWNER'],
      'pur.supplier_payment.approve': ['MANAGER', 'OWNER'],
      'pur.supplier_payment.create': ['ACCOUNTANT', 'MANAGER', 'OWNER'],
      'pur.supplier_payment.pay': ['ACCOUNTANT', 'OWNER'],
    });
  });
});
