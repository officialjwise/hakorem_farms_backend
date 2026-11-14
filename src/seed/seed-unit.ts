import type pg from 'pg';

/**
 * One module's contribution to the seeded farm (docs/TEST_STRATEGY.md section 8). Every record a unit writes is
 * marked as seed, and the unit is safe to run again. Module sessions register their units in seed-units.ts.
 */
export interface SeedUnit {
  readonly name: string;
  run(client: pg.PoolClient): Promise<{ readonly records: number }>;
}
