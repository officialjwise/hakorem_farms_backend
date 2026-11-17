import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateContractText, PUBLISHED_PATH, readYaml } from '../../../scripts/contract/generate';
import { readSeededRoles, SEEDED_ROLES_EXTENSION, type SeededRole } from '../../../scripts/contract/seeded-roles';
import { migrate } from '../../../src/platform/database/migration-runner';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const MIGRATIONS = resolve(__dirname, '../../../migrations');
const published = (readYaml(PUBLISHED_PATH)['components'] as { [key: string]: unknown })[SEEDED_ROLES_EXTENSION] as SeededRole[];

function holders(permission: string): string[] {
  return published.filter((role) => role.permissions.includes(permission)).map((role) => role.code);
}

/** A copy of `migrations/` with one more migration after the last, as a session would add one. */
function migrationsWith(name: string, sql: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'hk-migrations-'));
  for (const file of readdirSync(MIGRATIONS)) copyFileSync(join(MIGRATIONS, file), join(directory, file));
  writeFileSync(join(directory, name), sql);
  return directory;
}

describe('the seeded role matrix in the contract (CR-023, ADR-0071)', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database.drop();
  });

  it('is exactly what the migrations seed: every role, its full permissions and limits, in seed order', async () => {
    const seeded = await readSeededRoles((sql) => database.pool('admin').query(sql));
    expect(published).toEqual(seeded);
    expect(published.map((role) => role.code)).toEqual(['OWNER', 'MANAGER', 'ACCOUNTANT', 'STOREKEEPER', 'CASHIER', 'SALES', 'FARM_HAND', 'DRIVER', 'INVESTOR', 'CUSTOMER']);
    for (const role of published) expect(role.permissions).toEqual([...role.permissions].sort());
  });

  it('shows the credit-note grants the owner set on 2026-11-16 (0174): raised by the Owner, the Accountant and the Manager, approved by the Owner and the Manager', () => {
    expect(holders('bil.credit_note.create')).toEqual(['OWNER', 'MANAGER', 'ACCOUNTANT']);
    expect(holders('bil.credit_note.approve')).toEqual(['OWNER', 'MANAGER']);
    expect(holders('bil.credit_note.create')).not.toContain('CASHIER');
  });

  it("confirms the Farm hand's death report reads: the report, its reasons, locations, products and the evidence upload", () => {
    const farmHand = published.find((role) => role.code === 'FARM_HAND')!;
    expect(farmHand.permissions).toEqual(
      expect.arrayContaining(['liv.mortality.report', 'liv.care.read', 'mdm.reason_code.read', 'mdm.location.read', 'mdm.product.read', 'platform.file.upload.evidence']),
    );
    expect(farmHand.permissions).not.toContain('platform.file.upload');
    expect(farmHand.permissions).not.toContain('liv.mortality.read');
  });

  it('changes when a later migration changes a seeded grant, so the committed contract no longer matches and CI fails', async () => {
    const scratch = migrationsWith(
      '9999_iam_revoke_scratch_grant.sql',
      [
        '-- 9999_iam_revoke_scratch_grant: a scratch migration of this test, never committed to migrations/',
        '-- migrate:up',
        "DELETE FROM iam.role_permission rp USING iam.role r WHERE rp.role_id = r.id AND r.code = 'MANAGER' AND rp.permission_code = 'bil.credit_note.create';",
        '-- migrate:down',
        'SELECT 1;',
        '',
      ].join('\n'),
    );
    await migrate(database.url('migrator'), scratch);
    const changed = await readSeededRoles((sql) => database.pool('admin').query(sql));
    expect(changed.find((role) => role.code === 'MANAGER')!.permissions).not.toContain('bil.credit_note.create');
    const { text } = await generateContractText(changed);
    expect(text === readFileSync(PUBLISHED_PATH, 'utf8')).toBe(false);
  });
});
