import { createUuidV7Generator, type Clock, type UuidV7 } from '@hakorem/kernel';

/** What every factory receives: the test's clock and id generator, so data is deterministic (TEST_STRATEGY 8.6). */
export interface FactoryContext {
  readonly clock: Clock;
  readonly nextId: () => UuidV7;
  /** 1, 2, 3 ... per factory, for unique readable values. */
  readonly sequence: number;
}

export type Factory<T> = {
  /** One valid object; a test overrides only the fields it asserts on. */
  build(overrides?: Partial<T>): T;
  buildMany(count: number, overrides?: Partial<T>): T[];
};

/**
 * Defines a factory for an aggregate or a row (docs/TEST_STRATEGY.md section 8): valid by default, every field
 * overridable, ids from the kernel UUIDv7 generator, time from the clock. Factories, never fixture files.
 */
export function defineFactory<T>(clock: Clock, defaults: (context: FactoryContext) => T): Factory<T> {
  const nextId = createUuidV7Generator(clock);
  let sequence = 0;
  const build = (overrides: Partial<T> = {}): T => {
    sequence += 1;
    return { ...defaults({ clock, nextId, sequence }), ...overrides };
  };
  return {
    build,
    buildMany: (count, overrides) => Array.from({ length: count }, () => build(overrides)),
  };
}
