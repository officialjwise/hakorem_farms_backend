import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { HTTP_METHODS } from '../../../scripts/contract/build-contract';
import { PUBLISHED_PATH, readYaml } from '../../../scripts/contract/generate';
import type { Json } from '../../../scripts/contract/yaml-emitter';
import { closureOf } from '../../support/contract-closure';

type JsonObject = { [key: string]: Json };
const contract = readYaml(PUBLISHED_PATH);
const schemas = (contract['components'] as JsonObject)['schemas'] as JsonObject;

function operations(): Array<{ readonly operationId: string; readonly operation: JsonObject }> {
  const found: Array<{ readonly operationId: string; readonly operation: JsonObject }> = [];
  for (const item of Object.values(contract['paths'] as JsonObject)) {
    for (const [method, operation] of Object.entries((item ?? {}) as JsonObject)) {
      if ((HTTP_METHODS as readonly string[]).includes(method)) found.push({ operationId: String((operation as JsonObject)['operationId']), operation: operation as JsonObject });
    }
  }
  return found;
}

/** Every place under `node` whose key or text matches `pattern`, as a JSON pointer. */
function mentions(node: Json, pattern: RegExp, where: string, found: string[]): string[] {
  if (Array.isArray(node)) node.forEach((value, index) => mentions(value, pattern, `${where}/${index}`, found));
  else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (pattern.test(key)) found.push(`${where}/${key}`);
      mentions(value, pattern, `${where}/${key}`, found);
    }
  } else if (typeof node === 'string' && pattern.test(node)) found.push(where);
  return found;
}

describe('the TOTP enrolment QR is the only QR code (ADR-0072, owner 2026-11-17)', () => {
  it('names a QR code only in startTotpEnrolment and TotpEnrolment', () => {
    const qr = /\bqr\b|qrcode|qr code|qr_code/i;
    const where = [
      ...operations().flatMap(({ operationId, operation }) => mentions(operation, qr, operationId, [])),
      ...Object.entries(schemas).flatMap(([name, schema]) => mentions(schema, qr, name, [])),
    ];
    expect(new Set(where.map((pointer) => pointer.split('/')[0]))).toEqual(new Set(['startTotpEnrolment', 'TotpEnrolment']));
  });
});

describe('the meat pack labels stay byte for byte as built (owner 2026-11-17)', () => {
  it('gives createPacks, listPacks and printPackLabels exactly the shapes, examples and texts of contract 1.54.0', () => {
    const asBuilt = JSON.parse(readFileSync(resolve(__dirname, '../../fixtures/contract/meat-pack-labels-1.54.0.json'), 'utf8')) as unknown;
    const now = JSON.parse(JSON.stringify(closureOf(contract, ['createPacks', 'listPacks', 'printPackLabels']))) as unknown;
    expect(now).toEqual(asBuilt);
  });
});

describe('every example is valid against its schema (the frontend mock serves them)', () => {
  it('validates each request and response example of every operation, from code and planned', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema({ $id: 'contract', components: contract['components'] });
    const local = (schema: Json) => JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"contract#/components/')) as object;
    const failures: string[] = [];
    let checked = 0;
    for (const { operationId, operation } of operations()) {
      const media: Array<[string, JsonObject | undefined]> = [['request', ((operation['requestBody'] as JsonObject | undefined)?.['content'] as JsonObject | undefined)?.['application/json'] as JsonObject | undefined]];
      for (const [status, response] of Object.entries((operation['responses'] ?? {}) as JsonObject)) {
        media.push([status, ((response as JsonObject | null)?.['content'] as JsonObject | undefined)?.['application/json'] as JsonObject | undefined]);
      }
      for (const [where, content] of media) {
        if (content?.['schema'] === undefined) continue;
        const examples: Array<[string, Json]> = [];
        if (content['example'] !== undefined) examples.push(['example', content['example']]);
        for (const [name, example] of Object.entries((content['examples'] ?? {}) as JsonObject)) examples.push([name, (example as JsonObject)['value']!]);
        if (examples.length === 0) continue;
        const validate = ajv.compile(local(content['schema']));
        for (const [name, example] of examples) {
          checked += 1;
          if (!validate(example)) failures.push(`${operationId} ${where} ${name}: ${ajv.errorsText(validate.errors)}`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(1_000);
  });
});

/** The operations of the meat pack labels and of picking a pack, which keep their pack barcode (meat is future work). */
const MEAT_PACK_OPERATIONS = new Set(['createPacks', 'listPacks', 'printPackLabels', 'listFulfilments', 'getFulfilment', 'recordPicks', 'packFulfilment', 'dispatchFulfilment', 'collectFulfilment', 'cancelFulfilment']);
const MEAT_PACK_SCHEMAS = new Set(['Pack', 'PackLabel', 'PackLabelSheet', 'LabelBarcode', 'FulfilmentLine', 'PickInput']);

describe('no product barcode, barcode lookup or till scanning (ADR-0072, contract 2.0.0)', () => {
  it('leaves a barcode only on the meat pack labels and the picking of a pack, and elsewhere only in a text saying it went in 2.0.0', () => {
    const barcode = /barcode/i;
    const where = [
      ...operations().filter(({ operationId }) => !MEAT_PACK_OPERATIONS.has(operationId)).flatMap(({ operationId, operation }) => mentions(operation, barcode, operationId, [])),
      ...Object.entries(schemas).filter(([name]) => !MEAT_PACK_SCHEMAS.has(name)).flatMap(([name, schema]) => mentions(schema, barcode, name, [])),
    ];
    const text = (pointer: string): Json => pointer.split('/').slice(1).reduce<Json>((node, key) => (node as JsonObject)[key]!, pointer.split('/')[0]! in schemas ? schemas[pointer.split('/')[0]!]! : operations().find((o) => o.operationId === pointer.split('/')[0])!.operation);
    // A property, parameter or example that is a barcode is gone; a description may say that it went, and when.
    expect(where.filter((pointer) => !(pointer.endsWith('/description') && String(text(pointer)).includes('2.0.0')))).toEqual([]);
  });

  it('gives listProducts no barcode filter, and a product, its label, a lot or animal label and the offline pack no barcode', () => {
    const listProducts = operations().find(({ operationId }) => operationId === 'listProducts')!.operation;
    expect(((listProducts['parameters'] ?? []) as JsonObject[]).map((parameter) => parameter['name'])).not.toContain('barcode');
    for (const name of ['Product', 'ProductCreate', 'ProductUpdate', 'ProductLabel', 'StockUnitLabel', 'OfflineProduct']) {
      const schema = schemas[name] as JsonObject;
      expect(Object.keys(schema['properties'] as JsonObject), name).not.toContain('barcode');
      expect((schema['required'] ?? []) as string[], name).not.toContain('barcode');
    }
  });
});

describe('public IDs in place of the sequential customer and supplier numbers (ADR-0073, contract 2.0.0)', () => {
  it('names no customerNo or supplierNo anywhere: no property, parameter, example or text', () => {
    const numbers = /customerNo|supplierNo/;
    const where = [
      ...operations().flatMap(({ operationId, operation }) => mentions(operation, numbers, operationId, [])),
      ...Object.entries(schemas).flatMap(([name, schema]) => mentions(schema, numbers, name, [])),
    ];
    expect(where).toEqual([]);
  });

  it('gives every customer and supplier shape a required publicId of its own pattern', () => {
    for (const [name, kind] of [['Customer', 'Customer'], ['CustomerRef', 'Customer'], ['CustomerProfile', 'Customer'], ['Supplier', 'Supplier'], ['SupplierRef', 'Supplier']] as const) {
      const schema = schemas[name] as JsonObject;
      expect((schema['properties'] as JsonObject)['publicId'], name).toEqual({ $ref: `#/components/schemas/${kind}PublicId` });
      expect(schema['required'] as string[], name).toContain('publicId');
    }
    expect((schemas['CustomerPublicId'] as JsonObject)['pattern']).toBe('^cus_[0-9A-HJKMNP-TV-Z]{16}$');
    expect((schemas['SupplierPublicId'] as JsonObject)['pattern']).toBe('^sup_[0-9A-HJKMNP-TV-Z]{16}$');
  });

  it('shows one public ID per customer or supplier across every example, as the mock serves them', () => {
    const byId = new Map<string, Set<string>>();
    const walk = (node: Json): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node !== null && typeof node === 'object') {
        if (typeof node['id'] === 'string' && typeof node['publicId'] === 'string') {
          byId.set(node['id'], (byId.get(node['id']) ?? new Set()).add(node['publicId']));
        }
        Object.values(node).forEach(walk);
      }
    };
    for (const { operation } of operations()) walk(operation['responses'] ?? null);
    expect(byId.size).toBeGreaterThan(10);
    expect([...byId].filter(([, ids]) => ids.size > 1).map(([id]) => id)).toEqual([]);
  });
});
