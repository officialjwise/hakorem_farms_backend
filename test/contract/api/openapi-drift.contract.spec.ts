import { readFileSync } from 'node:fs';
import { Controller, Get, Module } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { describe, expect, it } from 'vitest';
import { buildContract, ContractMergeError, operationsOf } from '../../../scripts/contract/build-contract';
import { documentModule } from '../../../scripts/contract/code-document';
import { generateContractText, PLANNED_PATH, PUBLISHED_PATH, readYaml } from '../../../scripts/contract/generate';
import { emitYaml } from '../../../scripts/contract/yaml-emitter';

class ProbeSlot {
  @ApiProperty({ type: String, description: 'Delivery slot start, UTC' })
  startsAt!: string;
}

@Controller('probe-slots')
class ProbeSlotController {
  @Get()
  @ApiOperation({ operationId: 'listProbeSlots', summary: 'A code-defined operation the planned contract does not have' })
  @ApiOkResponse({ type: ProbeSlot })
  list(): ProbeSlot[] {
    return [];
  }
}

@Controller('health')
class DuplicateHealthController {
  @Get()
  @ApiOperation({ operationId: 'getHealth' })
  get(): string {
    return 'duplicate';
  }
}

@Module({ controllers: [ProbeSlotController] })
class ProbeSlotModule {}

@Module({ controllers: [DuplicateHealthController] })
class DuplicateHealthModule {}

describe('the contract is generated from code (FR-API-002, ADR-0030)', () => {
  it('fails when the generated contract differs from the committed one', async () => {
    const committed = readFileSync(PUBLISHED_PATH, 'utf8');
    // The committed file is exactly what the code and the planned contract produce today.
    const { text } = await generateContractText();
    expect(text === committed).toBe(true);

    // An operation added in code without regenerating makes the generated file differ, which fails CI.
    const withNewOperation = emitYaml(buildContract(readYaml(PLANNED_PATH), await documentModule(ProbeSlotModule)));
    expect(withNewOperation === committed).toBe(false);
    expect(withNewOperation).toContain('operationId: listProbeSlots');
  });

  it('documents the operations of decorated controllers when the graph is read in preview mode', async () => {
    const document = await documentModule(ProbeSlotModule);
    // Paths are relative to the server URL, which ends in /v1, exactly like the planned operations.
    expect(operationsOf(document)).toEqual(['GET /probe-slots']);
  });

  it('refuses an operation that is both in the code and still in the planned contract', async () => {
    const duplicate = await documentModule(DuplicateHealthModule);
    expect(() => buildContract(readYaml(PLANNED_PATH), duplicate)).toThrow(ContractMergeError);
  });

  it('keeps all 600 planned operations in the published contract', () => {
    expect(operationsOf(readYaml(PUBLISHED_PATH))).toHaveLength(600);
  });
});
