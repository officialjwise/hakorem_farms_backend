import { ValidationFailedError } from '../errors/api-error';
import { translate } from '../i18n/messages';

/** The SQL types a sort key may be cast to when it comes back from a cursor. */
export type SortKeyType = 'text' | 'bigint' | 'integer' | 'numeric' | 'date' | 'timestamp' | 'timestamptz' | 'uuid' | 'boolean';

export type SortDirection = 'asc' | 'desc';

/**
 * One field a list may be sorted by (CR-019): a SQL expression over the list's own row, written in code, never taken
 * from the request. An index backs every allowed field (the list's migration declares it beside the allow-list).
 * A nullable field sorts its nulls last in either direction.
 */
export interface SortFieldSpec {
  readonly expression: string;
  readonly type: SortKeyType;
  readonly nullable?: boolean;
}

/**
 * A list's allow-list of sort fields and its unique tie-breaker (the row id). Any field outside the allow-list is a
 * 400 with the code `SORT_NOT_ALLOWED`; nothing in the request reaches the SQL text.
 */
export interface SortFields<F extends string = string> {
  readonly fields: Readonly<Record<F, SortFieldSpec>>;
  readonly tieBreaker: { readonly expression: string; readonly type: SortKeyType };
}

/** The allow-list of a list whose default order is one of its own sort fields (the catalogue, the delivery slots). */
export interface SortSpec<F extends string = string> extends SortFields<F> {
  readonly defaultOrder: { readonly field: F; readonly direction: SortDirection };
}

/** The `sort` and `direction` query parameters of a sorted list, as the request sent them, checked by `requestedSort`. */
export interface SortRequest {
  readonly sort?: string | undefined;
  readonly direction?: string | undefined;
}

/** One key of the order: the expression, how its cursor value is cast, and which way it runs. */
export interface SortKey {
  readonly expression: string;
  readonly type: SortKeyType;
  readonly direction: SortDirection;
}

/** A sort the request asked for, checked against the allow-list. */
export interface SortOrder {
  readonly field: string;
  readonly direction: SortDirection;
  readonly keys: readonly SortKey[];
}

function notAllowed(field: string, pointer: string): ValidationFailedError {
  return new ValidationFailedError(`sort by ${field} is not allowed`, [{ field: pointer, code: 'SORT_NOT_ALLOWED', message: translate('error.field_invalid') }]);
}

/**
 * The order a list runs in: the asked field and direction (or the list's default), then the tie-breaker in the same
 * direction. A nullable field leads with `expression IS NULL` ascending, so its nulls come last either way, and the
 * field itself is coalesced so every key is comparable. A field not on the allow-list is refused.
 */
export function resolveSort<F extends string>(spec: SortSpec<F>, field: string | undefined, direction: string | undefined): SortOrder {
  return field === undefined ? orderOf(spec, spec.defaultOrder.field, direction ?? spec.defaultOrder.direction) : orderOf(spec, field, direction ?? 'asc');
}

/**
 * The sort a console list was asked for (CR-019), or null for the list's own default order, which is none of its sort
 * fields and answers exactly as it did before the list could be sorted: neither a field nor a direction was asked. A
 * field with no direction sorts ascending; a direction with no field is refused, since it has no field to turn.
 */
export function requestedSort<F extends string>(spec: SortFields<F>, field: string | undefined, direction: string | undefined): SortOrder | null {
  if (field !== undefined) return orderOf(spec, field, direction ?? 'asc');
  if (direction !== undefined) throw notAllowed(direction, '/direction');
  return null;
}

function orderOf<F extends string>(spec: SortFields<F>, chosen: string, dir: string): SortOrder {
  if (!Object.prototype.hasOwnProperty.call(spec.fields, chosen)) throw notAllowed(chosen, '/sort');
  if (dir !== 'asc' && dir !== 'desc') throw notAllowed(dir, '/direction');
  const definition = spec.fields[chosen as F];
  const keys: SortKey[] = [];
  if (definition.nullable === true) {
    keys.push({ expression: `((${definition.expression}) IS NULL)`, type: 'boolean', direction: 'asc' });
    keys.push({ expression: `COALESCE(${definition.expression}, ${zeroOf(definition.type)})`, type: definition.type, direction: dir });
  } else {
    keys.push({ expression: definition.expression, type: definition.type, direction: dir });
  }
  keys.push({ expression: spec.tieBreaker.expression, type: spec.tieBreaker.type, direction: dir });
  return { field: chosen, direction: dir, keys };
}

function zeroOf(type: SortKeyType): string {
  switch (type) {
    case 'text':
      return "''";
    case 'date':
      return "'epoch'::date";
    case 'timestamp':
      return "'epoch'::timestamp";
    case 'timestamptz':
      return "'epoch'::timestamptz";
    case 'uuid':
      return "'00000000-0000-0000-0000-000000000000'::uuid";
    case 'boolean':
      return 'false';
    default:
      return '0';
  }
}

/** The SQL a page query appends: a WHERE condition past the cursor (or `true`), the ORDER BY, and their values. */
export interface KeysetClause {
  readonly after: string;
  readonly orderBy: string;
  readonly values: readonly unknown[];
}

/**
 * The keyset condition for the rows strictly after `position` in `order`, numbered from parameter `$firstParameter`:
 * `k1 > v1 OR (k1 = v1 AND k2 > v2) OR ...`, each comparison in its key's direction. Because the last key is the unique
 * row id, no two rows share a position, so a page never repeats a row and never skips one, however many values tie
 * and whatever rows arrive between pages (a row inserted before the cursor is simply not on a later page).
 */
export function keysetClause(order: SortOrder, position: readonly string[] | null, firstParameter: number): KeysetClause {
  const orderBy = orderByOf(order);
  if (position === null) return { after: 'true', orderBy, values: [] };
  if (position.length !== order.keys.length) throw new Error('a cursor position names every sort key');
  const placeholder = (index: number) => `$${firstParameter + index}::${order.keys[index]!.type}`;
  const disjuncts = keysetComparisons(order).map((all) => `(${all.map((c) => `${c.key.expression} ${c.operator} ${placeholder(c.index)}`).join(' AND ')})`);
  return { after: `(${disjuncts.join(' OR ')})`, orderBy, values: [...position] };
}

/** The ORDER BY text of an order: each key in its direction. */
export function orderByOf(order: SortOrder): string {
  return order.keys.map((key) => `${key.expression} ${key.direction === 'asc' ? 'ASC' : 'DESC'}`).join(', ');
}

/** One comparison of the keyset condition: key `index` against the cursor's value `index`. */
export interface KeysetComparison {
  readonly key: SortKey;
  readonly index: number;
  readonly operator: '=' | '>' | '<';
}

/**
 * The keyset condition as data, for a query builder that numbers its own parameters (Drizzle): a disjunction of
 * conjunctions, the n-th saying "the keys before key n equal the cursor's and key n is strictly past it" in its
 * direction. `keysetClause` renders exactly these comparisons as SQL text.
 */
export function keysetComparisons(order: SortOrder): KeysetComparison[][] {
  return order.keys.map((key, index) => [
    ...order.keys.slice(0, index).map((earlier, j): KeysetComparison => ({ key: earlier, index: j, operator: '=' })),
    { key, index, operator: key.direction === 'asc' ? '>' : '<' },
  ]);
}

/** The select-list items that return each key's value as text, aliased `sort_key_0` onward, for the next cursor. */
export function sortKeySelect(order: SortOrder): string {
  return order.keys.map((key, index) => `(${key.expression})::text AS sort_key_${index}`).join(', ');
}

/** The cursor position of a row selected with `sortKeySelect`. */
export function positionOf(order: SortOrder, row: Readonly<Record<string, unknown>>): string[] {
  return order.keys.map((_key, index) => String(row[`sort_key_${index}`]));
}

/** A position as the `Cursors` body carries it, and back: keys `k0`, `k1`, and so on. */
export function encodePosition(position: readonly string[]): Record<string, string> {
  return Object.fromEntries(position.map((value, index) => [`k${index}`, value]));
}

export function decodePosition(order: SortOrder, body: Readonly<Record<string, string>>): string[] {
  const position = order.keys.map((_key, index) => body[`k${index}`]);
  if (position.some((value) => value === undefined)) {
    throw new ValidationFailedError('cursor is invalid', [{ field: '/cursor', code: 'INVALID_CURSOR', message: translate('error.field_invalid') }]);
  }
  return position as string[];
}
