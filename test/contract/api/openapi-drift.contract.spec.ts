import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, Get, Module, Post } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { buildContract, ContractMergeError, operationsOf } from '../../../scripts/contract/build-contract';
import { documentModule, OperationFragmentError } from '../../../scripts/contract/code-document';
import { generateContractText, PLANNED_PATH, PUBLISHED_PATH, readYaml } from '../../../scripts/contract/generate';
import { emitYaml } from '../../../scripts/contract/yaml-emitter';
import { Operation } from '../../../src/platform/http/operation';

const PUBLIC = { access: 'PUBLIC', realms: [], permission: null, idempotent: false, csrf: false, rateLimit: 'public' } as const;

@Controller('probe-slots')
class ProbeSlotController {
  @Get()
  @Operation({ operationId: 'listProbeSlots', ...PUBLIC })
  list(): string[] {
    return [];
  }
}

/** Claims an operation that is still planned: POST /files (uploadFile). */
@Controller('files')
class DuplicateUploadController {
  @Post()
  @Operation({ operationId: 'uploadFile', access: 'SESSION', realms: ['STAFF'], permission: 'platform.file.upload', idempotent: true, csrf: true, rateLimit: 'console' })
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
    // The committed file is exactly what the code and the planned contract produce today.
    const { text } = await generateContractText();
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
    const uploadFile = {
      operationId: 'uploadFile',
      tags: ['platform'],
      summary: 'duplicate',
      'x-permission': 'platform.file.upload',
      parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }, { $ref: '#/components/parameters/CsrfToken' }],
      security: [{ staffSession: [] }],
      responses: { '201': { description: 'OK' } },
    };
    const duplicate = await documentModule(DuplicateUploadModule, fragments({ uploadFile }));
    expect(() => buildContract(readYaml(PLANNED_PATH), duplicate)).toThrow(ContractMergeError);
  });

  it('keeps all 600 operations in the published contract, 17 of them now implemented in code', async () => {
    expect(operationsOf(readYaml(PUBLISHED_PATH))).toHaveLength(600);
    expect(operationsOf(readYaml(PLANNED_PATH))).toHaveLength(583);
  });
});
