/**
 * The outcome of an operation that can be refused for a business reason (ENGINEERING_STANDARDS section 3).
 * A refusal is a value the caller must look at, not an exception it may forget to catch.
 */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Transforms the value of a success and passes a refusal through unchanged. */
export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Chains a second step that can itself be refused; the first refusal wins. */
export function andThen<T, U, E, F>(result: Result<T, E>, fn: (value: T) => Result<U, F>): Result<U, E | F> {
  return result.ok ? fn(result.value) : result;
}
