import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { documentWorker } from '../../support/documents';
import type { TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createUser, enrolAndLogin, relaxRateLimits, testStartTime } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B08 continued 2b operations answer in the shapes of contract/openapi.yaml, over the seeded day, archived. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let owner: TotpSession;
let receiptId: string;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  await documentWorker(api, database, clock).settle();
  const branchId = (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  receiptId = (await database.pool('admin').query<{ id: string }>("SELECT id FROM bil.billing_document WHERE kind = 'RECEIPT'")).rows[0]!.id;
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('B08 continued 2b operations answer in the contract shapes', () => {
  it('templates and versions, a draft, an activation and a refused body', async () => {
    const page = await consoleGet(api.server, owner, '/v1/document-templates');
    expect(page.status).toBe(200);
    expectShape('DocumentTemplatePage', page.body);
    const template = page.body.data[0];
    expectShape('DocumentTemplate', (await consoleGet(api.server, owner, `/v1/document-templates/${template.id}`)).body);
    const versions = await consoleGet(api.server, owner, `/v1/document-templates/${template.id}/versions`);
    expectShape('TemplateVersionPage', versions.body);
    expectShape('TemplateVersion', (await consoleGet(api.server, owner, `/v1/template-versions/${template.activeVersion.id}`)).body);
    const draft = await consolePost(api.server, owner, `/v1/document-templates/${template.id}/versions`).send({ body: '<h1>{{title}} {{documentNo}}</h1>' });
    expect(draft.status).toBe(201);
    expectShape('TemplateVersion', draft.body);
    const active = await consolePost(api.server, owner, `/v1/template-versions/${draft.body.id}/activate`).send({});
    expect(active.status).toBe(200);
    expectShape('TemplateVersion', active.body);
    const refused = await consolePost(api.server, owner, `/v1/document-templates/${template.id}/versions`).send({ body: '<script></script>' });
    expect([refused.status, refused.body.error.code]).toEqual([422, 'TEMPLATE_BODY_INVALID']);
    expectShape('Error', refused.body);
  });

  it('a specimen preview of a template version, and its refusal without data (B08 continued 2c)', async () => {
    const page = await consoleGet(api.server, owner, '/v1/document-templates');
    const template = page.body.data.find((t: { docType: string; output: string }) => t.docType === 'INVOICE' && t.output === 'PDF_A4');
    const preview = await consolePost(api.server, owner, `/v1/template-versions/${template.activeVersion.id}/preview`).send({ data: { title: 'Invoice', documentNo: 'INV-X' } });
    expect(preview.status).toBe(200);
    expectShape('TemplatePreviewResult', preview.body);
    const refused = await consolePost(api.server, owner, `/v1/template-versions/${template.activeVersion.id}/preview`).send({});
    expect([refused.status, refused.body.error.code]).toEqual([422, 'PREVIEW_DATA_REQUIRED']);
    expectShape('Error', refused.body);
  });

  it('the archive, its download link, a reprint and the reprint log', async () => {
    const page = await consoleGet(api.server, owner, '/v1/documents?limit=10');
    expect(page.status).toBe(200);
    expectShape('ArchivedDocumentPage', page.body);
    // The seed's five billing documents and its customer statement (B08 continued 2d).
    expect(page.body.data).toHaveLength(6);
    const one = await consoleGet(api.server, owner, `/v1/documents/${page.body.data[0].id}`);
    expectShape('ArchivedDocument', one.body);
    const link = await consolePost(api.server, owner, `/v1/documents/${page.body.data[0].id}/download`).send({});
    expect(link.status).toBe(200);
    expectShape('SignedUrl', link.body);
    for (const channel of ['THERMAL', 'PDF']) {
      const reprint = await consolePost(api.server, owner, `/v1/billing-documents/${receiptId}/reprint`).send({ channel });
      expect(reprint.status).toBe(200);
      expectShape('ReprintResult', reprint.body);
    }
    const log = await consoleGet(api.server, owner, `/v1/billing-documents/${receiptId}/reprints`);
    expectShape('ReprintLogPage', log.body);
    expect(log.body.data.map((r: { copyNo: number }) => r.copyNo)).toEqual([1, 2]);
    expectShape('BillingDocument', (await consoleGet(api.server, owner, `/v1/billing-documents/${receiptId}`)).body);
  });
});
