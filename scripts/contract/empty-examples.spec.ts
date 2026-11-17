import { describe, expect, it } from 'vitest';
import { emptyOf, withEmptyExample } from './empty-examples';
import type { Json } from './yaml-emitter';

type JsonObject = { [key: string]: Json };

const LIMIT_REF = { $ref: '#/components/parameters/Limit' };
const PARAMETERS: JsonObject = { Limit: { name: 'limit', in: 'query', schema: { $ref: '#/components/schemas/PageLimit' } } };
const SCHEMAS: JsonObject = { PageLimit: { type: 'integer', minimum: 1, maximum: 100, default: 25 } };
const COMPONENTS = { parameters: PARAMETERS, schemas: SCHEMAS };

const ROWS = {
  data: [
    { id: 'a', name: 'Eggs, big, crate of 30' },
    { id: 'b', name: 'Goat, live' },
  ],
  page: { nextCursor: 'eyJpZCI6ImIifQ', limit: 25, hasMore: true },
};

function listOperation(media: JsonObject, parameters: Json[] = [LIMIT_REF]): JsonObject {
  return {
    operationId: 'listProducts',
    parameters,
    responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/ProductPage' }, ...media } } } },
  };
}

function mediaOf(operation: JsonObject): JsonObject {
  return (((operation['responses'] as JsonObject)['200'] as JsonObject)['content'] as JsonObject)['application/json'] as JsonObject;
}

describe('the named empty example of a list (CR-005)', () => {
  it('moves the single example under default and adds empty with no rows, no next page and the default limit', () => {
    const changed = withEmptyExample('get', listOperation({ example: ROWS }), COMPONENTS);
    expect(mediaOf(changed)).toEqual({
      schema: { $ref: '#/components/schemas/ProductPage' },
      examples: {
        default: { value: ROWS },
        empty: { summary: 'Nothing matches: no rows and no next page', value: { data: [], page: { nextCursor: null, limit: 25, hasMore: false } } },
      },
    });
  });

  it('takes the default limit from an inline limit parameter when the operation declares its own', () => {
    const inline = { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } };
    const changed = withEmptyExample('get', listOperation({ example: ROWS }, [inline]), COMPONENTS);
    expect(((mediaOf(changed)['examples'] as JsonObject)['empty'] as JsonObject)['value']).toEqual({ data: [], page: { nextCursor: null, limit: 50, hasMore: false } });
  });

  it('falls back to the example page limit for a list that takes no limit', () => {
    const changed = withEmptyExample('get', listOperation({ example: { ...ROWS, page: { ...ROWS.page, limit: 100 } } }, []), COMPONENTS);
    expect((((mediaOf(changed)['examples'] as JsonObject)['empty'] as JsonObject)['value'] as JsonObject)['page']).toEqual({ nextCursor: null, limit: 100, hasMore: false });
  });

  it('keeps already named examples and adds empty beside them from the first', () => {
    const changed = withEmptyExample('get', listOperation({ examples: { counting: { summary: 'Counting', value: ROWS }, inReview: { value: ROWS } } }), COMPONENTS);
    const examples = mediaOf(changed)['examples'] as JsonObject;
    expect(Object.keys(examples)).toEqual(['counting', 'inReview', 'empty']);
    expect((examples['empty'] as JsonObject)['value']).toEqual({ data: [], page: { nextCursor: null, limit: 25, hasMore: false } });
  });

  it('is idempotent: a second pass changes nothing', () => {
    const once = withEmptyExample('get', listOperation({ example: ROWS }), COMPONENTS);
    expect(withEmptyExample('get', once, COMPONENTS)).toEqual(once);
  });

  it('leaves alone an operation that is not a list: not a GET, or no rows and page in its example', () => {
    const put = listOperation({ example: ROWS });
    expect(withEmptyExample('put', put, COMPONENTS)).toEqual(put);
    const single = listOperation({ example: { id: 'a', name: 'Goat' } });
    expect(withEmptyExample('get', single, COMPONENTS)).toEqual(single);
  });

  it('zeroes the figures beside the rows so the empty answer agrees with itself', () => {
    expect(
      emptyOf(
        {
          data: [{ id: 'a' }],
          page: { nextCursor: null, limit: 25, hasMore: false },
          totalValueAtCostPesewas: 13_816_210,
          totalUnits: '4200.0000',
          currency: 'GHS',
          asOf: '2026-11-13T09:30:00Z',
          balanced: true,
          branchId: null,
          totals: { currentPesewas: 1_517_500, grossMarginPercent: '30.40' },
          counts: { added: 3, unchanged: 33 },
          facets: { categories: [{ code: 'MEAT', count: 5 }] },
        },
        25,
      ),
    ).toEqual({
      data: [],
      page: { nextCursor: null, limit: 25, hasMore: false },
      totalValueAtCostPesewas: 0,
      totalUnits: '0.0000',
      currency: 'GHS',
      asOf: '2026-11-13T09:30:00Z',
      balanced: true,
      branchId: null,
      totals: { currentPesewas: 0, grossMarginPercent: '0.00' },
      counts: { added: 0, unchanged: 0 },
      facets: { categories: [] },
    });
  });
});
