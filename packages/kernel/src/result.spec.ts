import { describe, expect, it } from 'vitest';
import { andThen, err, mapResult, ok, type Result } from './result';

function halve(n: bigint): Result<bigint, 'ODD'> {
  return n % 2n === 0n ? ok(n / 2n) : err('ODD');
}

describe('Result', () => {
  it('carries a value on success', () => {
    const result = ok(42n);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42n);
  });

  it('carries an error on refusal', () => {
    const result = err('INSUFFICIENT_STOCK');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('INSUFFICIENT_STOCK');
  });

  it('maps the value of a success', () => {
    expect(mapResult(ok(20n), (n) => n + 1n)).toEqual(ok(21n));
  });

  it('passes a refusal through a map unchanged', () => {
    const refused = err('CLOSED_PERIOD') as Result<bigint, string>;
    expect(mapResult(refused, (n) => n + 1n)).toEqual(err('CLOSED_PERIOD'));
  });

  it('chains a step that succeeds', () => {
    expect(andThen(ok(8n), halve)).toEqual(ok(4n));
  });

  it('chains a step that refuses', () => {
    expect(andThen(ok(7n), halve)).toEqual(err('ODD'));
  });

  it('keeps the first refusal when chaining', () => {
    const refused = err('FIRST') as Result<bigint, 'FIRST'>;
    expect(andThen(refused, halve)).toEqual(err('FIRST'));
  });
});
