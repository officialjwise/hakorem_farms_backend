import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The owner's condition on the procurement grants (2026-11-15, A-169): no single role can both change a supplier's
 * payout details (ask for a change or approve one) and approve or record a payment to that supplier (prepare it,
 * approve it or mark it paid). Read from the grants the migrations write, so any later grant that joins the two fails here.
 * The Owner is the one role that holds both, and must while nobody may grant a role holding a permission they do not
 * hold themselves (A-120, ADR-0043): the Owner grants every other role. That conflict is with the owner (A-169).
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
  it('grants no role but the Owner both a payout detail permission and a supplier payment permission', async () => {
    const { rows } = await database.pool('admin').query<{ role: string; payout: string[]; payment: string[] }>(
      `SELECT r.code AS role,
              array_agg(DISTINCT rp.permission_code) FILTER (WHERE rp.permission_code = ANY($1::text[])) AS payout,
              array_agg(DISTINCT rp.permission_code) FILTER (WHERE rp.permission_code = ANY($2::text[])) AS payment
         FROM iam.role r JOIN iam.role_permission rp ON rp.role_id = r.id
        WHERE r.deleted_at IS NULL
        GROUP BY r.code
       HAVING bool_or(rp.permission_code = ANY($1::text[])) AND bool_or(rp.permission_code = ANY($2::text[]))`,
      [PAYOUT_SIDE, PAYMENT_SIDE],
    );
    expect(rows.map((r) => r.role)).toEqual(['OWNER']);
  });

  it('still lets a payout change and a payment each have a maker and a different checker', async () => {
    const { rows } = await database.pool('admin').query<{ permission_code: string; roles: string[] }>(
      `SELECT rp.permission_code, array_agg(r.code ORDER BY r.code) AS roles
         FROM iam.role_permission rp JOIN iam.role r ON r.id = rp.role_id
        WHERE r.deleted_at IS NULL AND rp.permission_code = ANY($1::text[])
        GROUP BY rp.permission_code ORDER BY rp.permission_code`,
      [[...PAYOUT_SIDE, ...PAYMENT_SIDE]],
    );
    expect(Object.fromEntries(rows.map((r) => [r.permission_code, r.roles]))).toEqual({
      'pur.supplier.payout_approve': ['OWNER'],
      'pur.supplier.payout_change': ['OWNER'],
      'pur.supplier_payment.approve': ['MANAGER', 'OWNER'],
      'pur.supplier_payment.create': ['ACCOUNTANT', 'OWNER'],
      'pur.supplier_payment.pay': ['ACCOUNTANT', 'OWNER'],
    });
  });
});
