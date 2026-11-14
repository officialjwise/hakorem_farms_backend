/**
 * JSON with object keys sorted at every level and no insignificant whitespace, so equal values always give equal
 * bytes: audit before and after values (ADR-0006), idempotency request hashes (ADR-0014) and approval payload
 * hashes (ADR-0017) are computed over it. `undefined` properties are dropped, as JSON.stringify drops them.
 * Bigints are written as decimal strings; anything else JSON cannot carry is refused.
 */
export function canonicalJson(value: unknown): string {
  return write(value);
}

function write(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('canonicalJson: a non-finite number has no JSON form');
      }
      return JSON.stringify(value);
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: a ${typeof value} has no JSON form`);
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => (item === undefined ? 'null' : write(item))).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${write(item)}`).join(',')}}`;
}
