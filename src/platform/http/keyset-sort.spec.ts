import { describe, expect, it } from 'vitest';
import { ValidationFailedError } from '../errors/api-error';
import { decodePosition, encodePosition, keysetClause, positionOf, resolveSort, sortKeySelect, type SortSpec } from './keyset-sort';

const spec: SortSpec<'name' | 'price'> = {
  fields: {
    name: { expression: 'lower(p.name)', type: 'text' },
    price: { expression: 'p.price_pesewas', type: 'bigint', nullable: true },
  },
  tieBreaker: { expression: 'p.id', type: 'uuid' },
  defaultOrder: { field: 'name', direction: 'asc' },
};

function refusal(run: () => unknown): { field: string | null; code: string } | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof ValidationFailedError) return { field: error.details[0]!.field, code: error.details[0]!.code };
    throw error;
  }
  return undefined;
}

describe('the shared sort (CR-019)', () => {
  it('uses the list default when no sort is asked, with the id as the tie-breaker in the same direction', () => {
    const order = resolveSort(spec, undefined, undefined);
    expect(order.field).toBe('name');
    expect(keysetClause(order, null, 1)).toEqual({ after: 'true', orderBy: 'lower(p.name) ASC, p.id ASC', values: [] });
  });

  it('refuses a field outside the allow-list with SORT_NOT_ALLOWED, and never puts it in the SQL', () => {
    expect(refusal(() => resolveSort(spec, 'cost_pesewas; DROP TABLE x', 'asc'))).toEqual({ field: '/sort', code: 'SORT_NOT_ALLOWED' });
    expect(refusal(() => resolveSort(spec, 'toString', undefined))).toEqual({ field: '/sort', code: 'SORT_NOT_ALLOWED' });
  });

  it('refuses a direction other than asc or desc', () => {
    expect(refusal(() => resolveSort(spec, 'name', 'sideways'))).toEqual({ field: '/direction', code: 'SORT_NOT_ALLOWED' });
  });

  it('sorts ascending when a field is asked without a direction', () => {
    expect(resolveSort(spec, 'name', undefined).direction).toBe('asc');
  });

  it('puts the nulls of a nullable field last in both directions and coalesces the field', () => {
    const desc = resolveSort(spec, 'price', 'desc');
    expect(keysetClause(desc, null, 1).orderBy).toBe('((p.price_pesewas) IS NULL) ASC, COALESCE(p.price_pesewas, 0) DESC, p.id DESC');
  });

  it('pages strictly after the cursor, key by key, in each key direction', () => {
    const clause = keysetClause(resolveSort(spec, 'name', 'desc'), ['goat', '019a7a8d-137d-74bf-b9f8-54cda260cdab'], 3);
    expect(clause.after).toBe('((lower(p.name) < $3::text) OR (lower(p.name) = $3::text AND p.id < $4::uuid))');
    expect(clause.values).toEqual(['goat', '019a7a8d-137d-74bf-b9f8-54cda260cdab']);
  });

  it('refuses a cursor position that does not name every key', () => {
    expect(() => keysetClause(resolveSort(spec, 'name', 'asc'), ['goat'], 1)).toThrow('names every sort key');
  });

  it('selects each key as text and reads the position back from the row', () => {
    const order = resolveSort(spec, 'price', 'asc');
    expect(sortKeySelect(order)).toBe('(((p.price_pesewas) IS NULL))::text AS sort_key_0, (COALESCE(p.price_pesewas, 0))::text AS sort_key_1, (p.id)::text AS sort_key_2');
    expect(positionOf(order, { sort_key_0: 'false', sort_key_1: '4500', sort_key_2: 'x' })).toEqual(['false', '4500', 'x']);
  });

  it('carries a position through a cursor body and refuses a body missing a key', () => {
    const order = resolveSort(spec, 'price', 'asc');
    expect(decodePosition(order, encodePosition(['false', '4500', 'x']))).toEqual(['false', '4500', 'x']);
    expect(refusal(() => decodePosition(order, { k0: 'false' }))).toEqual({ field: '/cursor', code: 'INVALID_CURSOR' });
  });

  it('coalesces each key type to a comparable zero', () => {
    const typed: SortSpec<'a' | 'b' | 'c' | 'd' | 'e'> = {
      fields: {
        a: { expression: 'x.a', type: 'text', nullable: true },
        b: { expression: 'x.b', type: 'date', nullable: true },
        c: { expression: 'x.c', type: 'timestamptz', nullable: true },
        d: { expression: 'x.d', type: 'uuid', nullable: true },
        e: { expression: 'x.e', type: 'boolean', nullable: true },
      },
      tieBreaker: { expression: 'x.id', type: 'uuid' },
      defaultOrder: { field: 'a', direction: 'asc' },
    };
    const second = (field: string) => keysetClause(resolveSort(typed, field, 'asc'), null, 1).orderBy.replace(`((x.${field}) IS NULL) ASC, `, '').replace(', x.id ASC', '');
    expect(second('a')).toBe("COALESCE(x.a, '') ASC");
    expect(second('b')).toBe("COALESCE(x.b, 'epoch'::date) ASC");
    expect(second('c')).toBe("COALESCE(x.c, 'epoch'::timestamptz) ASC");
    expect(second('d')).toBe("COALESCE(x.d, '00000000-0000-0000-0000-000000000000'::uuid) ASC");
    expect(second('e')).toBe('COALESCE(x.e, false) ASC');
  });
});
