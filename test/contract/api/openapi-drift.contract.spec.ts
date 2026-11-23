import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, Get, Module } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { buildContract, ContractMergeError, operationsOf } from '../../../scripts/contract/build-contract';
import { documentModule, OperationFragmentError } from '../../../scripts/contract/code-document';
import { generateContractText, PLANNED_PATH, PUBLISHED_PATH, readYaml } from '../../../scripts/contract/generate';
import { readSeededRoles } from '../../../scripts/contract/seeded-roles';
import { emitYaml } from '../../../scripts/contract/yaml-emitter';
import { Operation } from '../../../src/platform/http/operation';
import { createTestDatabase } from '../../support/test-database';

const PUBLIC = { access: 'PUBLIC', realms: [], permission: null, idempotent: false, csrf: false, rateLimit: 'public' } as const;

@Controller('probe-slots')
class ProbeSlotController {
  @Get()
  @Operation({ operationId: 'listProbeSlots', ...PUBLIC })
  list(): string[] {
    return [];
  }
}

/** Claims an operation that is still planned (B12): GET /investors (listInvestors). */
@Controller('investors')
class DuplicateUploadController {
  @Get()
  @Operation({ operationId: 'listInvestors', access: 'SESSION', realms: ['STAFF'], permission: 'cap.investor.read', idempotent: false, csrf: false, rateLimit: 'console' })
  upload(): string {
    return 'duplicate';
  }
}

@Module({ controllers: [ProbeSlotController] })
class ProbeSlotModule {}

@Module({ controllers: [DuplicateUploadController] })
class DuplicateUploadModule {}

/** A directory of operation fragments for the probe modules, laid out as the modules lay theirs out. */
function fragments(files: Record<string, object>): string {
  const root = mkdtempSync(join(tmpdir(), 'hk-fragments-'));
  const directory = join(root, 'probe', 'interface', 'openapi');
  mkdirSync(directory, { recursive: true });
  for (const [operationId, operation] of Object.entries(files)) {
    writeFileSync(join(directory, `${operationId}.yaml`), emitYaml(operation as never));
  }
  return root;
}

const listProbeSlots = {
  operationId: 'listProbeSlots',
  tags: ['platform'],
  summary: 'A code-defined operation the planned contract does not have',
  security: [],
  responses: { '200': { description: 'OK' } },
};

describe('the contract is generated from code (FR-API-002, ADR-0030, ADR-0031)', () => {
  it('fails when the generated contract differs from the committed one', async () => {
    const committed = readFileSync(PUBLISHED_PATH, 'utf8');
    // The committed file is exactly what the code, the planned contract and the migrated seed produce today. The
    // run's migrated database stands in for the throwaway one `pnpm contract:generate` starts (CR-023).
    const database = await createTestDatabase();
    const roles = await readSeededRoles((sql) => database.pool('admin').query(sql)).finally(() => database.drop());
    const { text } = await generateContractText(roles);
    expect(text === committed).toBe(true);

    // An operation added in code without regenerating makes the generated file differ, which fails CI.
    const probe = await documentModule(ProbeSlotModule, fragments({ listProbeSlots }));
    const withNewOperation = emitYaml(buildContract(readYaml(PLANNED_PATH), probe));
    expect(withNewOperation === committed).toBe(false);
    expect(withNewOperation).toContain('operationId: listProbeSlots');
  });

  it('documents each route with the fragment beside its controller, at the route\'s own method and path', async () => {
    const document = await documentModule(ProbeSlotModule, fragments({ listProbeSlots }));
    // Paths are relative to the server URL, which ends in /v1, exactly like the planned operations.
    expect(operationsOf(document)).toEqual(['GET /probe-slots']);
  });

  it('refuses a route with no fragment, a fragment with no route, and a fragment that contradicts its route', async () => {
    await expect(documentModule(ProbeSlotModule, fragments({}))).rejects.toThrow(/listProbeSlots has no fragment/);
    await expect(documentModule(ProbeSlotModule, fragments({ listProbeSlots, orphanOperation: { ...listProbeSlots, operationId: 'orphanOperation' } }))).rejects.toThrow(
      /describes orphanOperation, which no route implements/,
    );
    const contradicting = { ...listProbeSlots, 'x-permission': 'mdm.product.read', parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }], security: [{ staffSession: [] }] };
    const failure = await documentModule(ProbeSlotModule, fragments({ listProbeSlots: contradicting })).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OperationFragmentError);
    expect((failure as OperationFragmentError).problems).toEqual([
      expect.stringContaining('x-permission is mdm.product.read but the route checks null'),
      expect.stringContaining('Idempotency-Key is declared but the route does not take it'),
      expect.stringContaining('a public route declares security staffSession'),
    ]);
  });

  it('refuses an operation that is both in the code and still in the planned contract', async () => {
    const listInvestors = {
      operationId: 'listInvestors',
      tags: ['cap'],
      summary: 'duplicate',
      'x-permission': 'cap.investor.read',
      security: [{ staffSession: [] }],
      responses: { '200': { description: 'OK' } },
    };
    const duplicate = await documentModule(DuplicateUploadModule, fragments({ listInvestors }));
    expect(() => buildContract(readYaml(PLANNED_PATH), duplicate)).toThrow(ContractMergeError);
  });

  it('keeps all 664 operations in the published contract (syncOfflineSales moved into code in 2.13.0; seven WHL operations moved into code and two credit check operations added in 2.14.0; four ageing and dunning operations moved into code in 2.15.0; four till PIN and witness operations added in 2.17.0; eight standing order operations and the write-off moved into code in 2.18.0; listMyQuotes moved into code and revokeQuoteLink added in 2.21.0; getQuotePipeline moved into code in 2.23.0; getPublicReceipt added in 2.24.0; nine picking operations moved into code and proposeShortPick added in 2.25.0; revokeReceiptLink and payInvoiceAtTill added in 2.26.0; dispatchFulfilment and four delivery operations moved into code in 2.27.0; getOrderFulfilmentView added in 2.29.0; three driver cash operations moved into code and handInDriverCash added in 2.31.0; eight route and driver operations moved into code and completeRoute and listDrivers added in 2.32.0; returnDeliveryToStock moved into code and writeOffDelivery and listDriverGoodsVariances added in 2.33.0; assignDelivery and rescheduleDelivery moved into code in 2.34.0; listShiftDriverCashHolders added and cancelDelivery moved into code in 2.35.0), 545 of them now implemented in code', async () => {
    expect(operationsOf(readYaml(PUBLISHED_PATH))).toHaveLength(664);
    expect(operationsOf(readYaml(PLANNED_PATH))).toHaveLength(119);
  });
});
