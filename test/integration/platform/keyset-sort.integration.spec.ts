import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keysetClause, positionOf, resolveSort, sortKeySelect, type SortOrder, type SortSpec } from '../../../src/platform/http/keyset-sort';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The shared sort mechanism against real PostgreSQL (CR-019): a list sorted by a field whose values tie in long runs,
 * some of them null, is paged two rows at a time while other connections insert rows between pages. Every row that
 * existed before the walk began is seen exactly once, in the asked order; a row inserted mid-walk is seen at most once.
 */
let database: TestDatabase;

const spec: SortSpec<'price' | 'name'> = {
  fields: {
    price: { expression: 's.price_pesewas', type: 'bigint', nullable: true },
    name: { expression: 'lower(s.name)', type: 'text' },
  },
  tieBreaker: { expression: 's.id', type: 'uuid' },
  defaultOrder: { field: 'name', direction: 'asc' },
};

async function insert(name: string, price: number | null): Promise<string> {
  const id = randomUUID();
  await database.pool('admin').query('INSERT INTO public.sort_probe (id, name, price_pesewas) VALUES ($1, $2, $3)', [id, name, price]);
  return id;
}

async function page(order: SortOrder, position: string[] | null, limit: number): Promise<{ ids: string[]; next: string[] | null }> {
  const clause = keysetClause(order, position, 2);
  const { rows } = await database
    .pool('admin')
    .query<Record<string, string>>(`SELECT s.id, ${sortKeySelect(order)} FROM public.sort_probe s WHERE ${clause.after} ORDER BY ${clause.orderBy} LIMIT $1`, [limit, ...clause.values]);
  const last = rows.at(-1);
  return { ids: rows.map((row) => row['id']!), next: rows.length < limit || last === undefined ? null : positionOf(order, last) };
}

async function walk(order: SortOrder, between: (pageNo: number) => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  let position: string[] | null = null;
  for (let pageNo = 0; pageNo < 100; pageNo += 1) {
    const result = await page(order, position, 2);
    seen.push(...result.ids);
    if (result.next === null) return seen;
    position = result.next;
    await between(pageNo);
  }
  throw new Error('the walk did not end');
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.pool('admin').query('CREATE TABLE public.sort_probe (id uuid PRIMARY KEY, name text NOT NULL, price_pesewas bigint NULL)');
  await database.pool('admin').query('CREATE INDEX ix_sort_probe_price ON public.sort_probe ((price_pesewas IS NULL), COALESCE(price_pesewas, 0), id)');
});

afterAll(async () => {
  await database.drop();
});

describe('paging a sorted list (CR-019)', () => {
  it('sees every original row exactly once, in order, through ties, nulls and concurrent inserts', async () => {
    const original = new Map<string, { name: string; price: number | null }>();
    const prices = [4_500, 4_500, 4_500, 6_000, 6_000, null, 4_500, 1_000, null, 6_000, 4_500, 3_500, 3_500];
    for (const [index, price] of prices.entries()) {
      const name = `Crate ${String(index).padStart(2, '0')}`;
      original.set(await insert(name, price), { name, price });
    }
    for (const direction of ['asc', 'desc'] as const) {
      const order = resolveSort(spec, 'price', direction);
      const inserted = new Set<string>();
      const seen = await walk(order, async (pageNo) => {
        // Rows arrive between the first pages, at a tied price on both sides of the cursor, and with no price at all.
        if (pageNo >= 4) return;
        const [a, b, c] = await Promise.all([insert(`New ${direction} ${pageNo} a`, 4_500), insert(`New ${direction} ${pageNo} b`, 6_000), insert(`New ${direction} ${pageNo} c`, null)]);
        inserted.add(a).add(b).add(c);
      });
      const fromOriginal = seen.filter((id) => original.has(id));
      expect(new Set(seen).size).toBe(seen.length);
      expect(fromOriginal.length).toBe(original.size);
      expect(seen.every((id) => original.has(id) || inserted.has(id))).toBe(true);
      // The original rows come in the asked order: priced rows by price then id, the unpriced last.
      const expected = [...original.entries()]
        .sort(([idA, a], [idB, b]) => {
          if ((a.price === null) !== (b.price === null)) return a.price === null ? 1 : -1;
          const byPrice = (a.price ?? 0) - (b.price ?? 0);
          if (byPrice !== 0) return direction === 'asc' ? byPrice : -byPrice;
          return direction === 'asc' ? (idA < idB ? -1 : 1) : idA < idB ? 1 : -1;
        })
        .map(([id]) => id);
      expect(fromOriginal).toEqual(expected);
      for (const id of inserted) original.set(id, { name: 'inserted', price: null });
      const { rows } = await database.pool('admin').query<{ id: string; price_pesewas: string | null }>('SELECT id, price_pesewas FROM public.sort_probe');
      for (const row of rows) original.set(row.id, { name: '', price: row.price_pesewas === null ? null : Number(row.price_pesewas) });
    }
  });

  it('walks a text sort with case-insensitive ties broken by the id', async () => {
    await insert('Yam', 2_000);
    await insert('yam', 2_000);
    await insert('YAM', 2_000);
    const order = resolveSort(spec, 'name', 'asc');
    const seen = await walk(order, async () => undefined);
    const { rows } = await database.pool('admin').query<{ id: string }>('SELECT id FROM public.sort_probe ORDER BY lower(name), id');
    expect(seen).toEqual(rows.map((row) => row.id));
  });
});
