import { describe, expect, it } from 'vitest';
import { readArchitecture } from './architecture';
import { schemaNameProblems } from './schema-names';
import { placementProblems } from './test-placement';

const architecture = readArchitecture();

describe('schema names in code (MODULE_BOUNDARIES section 7, data check 2)', () => {
  it('passes a migration that names only its own schema and the shared platform objects', () => {
    const sql = [
      'CREATE TABLE inv.stock_exception (',
      '  value_pesewas platform.pesewas,',
      '  actor_id uuid REFERENCES iam.principal (id) ON DELETE RESTRICT,',
      '  product_id uuid REFERENCES mdm.product (id) ON DELETE RESTRICT',
      ');',
      'CREATE TRIGGER t BEFORE UPDATE ON inv.stock_exception FOR EACH ROW EXECUTE FUNCTION platform.reject_change();',
    ].join('\n');
    expect(schemaNameProblems('0042_inv_add_stock_exception.sql', 'inv', sql, architecture)).toEqual([]);
  });

  it('fails a select from another module, and a foreign key to an unpublished table', () => {
    const sql = [
      'INSERT INTO inv.copy SELECT * FROM ord.sales_order_line;',
      'ALTER TABLE inv.x ADD COLUMN note_id uuid REFERENCES iam.session_note (id);',
    ].join('\n');
    expect(schemaNameProblems('0043_inv_bad.sql', 'inv', sql, architecture)).toEqual([
      '0043_inv_bad.sql:1: names ord.sales_order_line, which belongs to another schema',
      '0043_inv_bad.sql:2: names iam.session_note, which belongs to another schema',
    ]);
  });

  it('fails a platform table that is not a shared object', () => {
    expect(schemaNameProblems('0044_inv_bad.sql', 'inv', 'SELECT * FROM platform.audit_event;', architecture)).toEqual([
      '0044_inv_bad.sql:1: names platform.audit_event, which belongs to another schema',
    ]);
  });

  it('lets reporting read a published view and nobody else', () => {
    expect(schemaNameProblems('0090_rpt_add_fact.sql', 'rpt', 'SELECT * FROM ord.pub_order_line;', architecture)).toEqual([]);
    expect(schemaNameProblems('0091_whl_bad.sql', 'whl', 'SELECT * FROM ord.pub_order_line;', architecture)).toEqual([
      '0091_whl_bad.sql:1: names ord.pub_order_line, which belongs to another schema',
    ]);
  });

  it('ignores names inside quoted literals of a migration, and keeps them in TypeScript, where literals are SQL', () => {
    const migration = "INSERT INTO iam.permission (code) VALUES ('mdm.product.read');";
    expect(schemaNameProblems('migrations/0007_iam_seed.sql', 'iam', migration, architecture)).toEqual([]);
    const repository = "await tx.query('SELECT * FROM inv.stock_balance');";
    expect(schemaNameProblems('src/modules/mdm/infrastructure/x.ts', 'mdm', repository, architecture)).toHaveLength(1);
  });

  it('ignores names in comments', () => {
    expect(schemaNameProblems('0045_inv_ok.sql', 'inv', '-- unlike ord.sales_order, this stays in inv', architecture)).toEqual([]);
  });
});

describe('test placement (TEST_STRATEGY section 4)', () => {
  it('passes unit specs beside the code and layered specs under test/', () => {
    expect(
      placementProblems([
        'packages/kernel/src/money.spec.ts',
        'test/integration/platform/unit-of-work.integration.spec.ts',
        'test/smoke/health.smoke.spec.ts',
      ]),
    ).toEqual([]);
  });

  it('fails a spec under test/ with no layer, one in the wrong folder, and a layered spec beside the code', () => {
    expect(
      placementProblems(['test/integration/inv/goods-receipt.spec.ts', 'test/e2e/health.contract.spec.ts', 'src/platform/health/health.integration.spec.ts']),
    ).toEqual([
      'test/integration/inv/goods-receipt.spec.ts: a spec under test/ needs a layer suffix (.integration.spec.ts, .contract.spec.ts, .e2e.spec.ts, .smoke.spec.ts)',
      'test/e2e/health.contract.spec.ts: a .contract.spec.ts file belongs under test/contract/',
      'src/platform/health/health.integration.spec.ts: only unit specs sit beside the code; move it under test/integration/',
    ]);
  });
});
