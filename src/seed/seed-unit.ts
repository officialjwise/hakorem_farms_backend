import type { INestApplicationContext } from '@nestjs/common';
import type pg from 'pg';

/**
 * One module's contribution to the seeded farm (docs/TEST_STRATEGY.md section 8). Every record a unit writes is
 * marked as seed, and the unit is safe to run again. Module sessions register their units in seed-units.ts.
 *
 * A `SQL` unit writes rows in one transaction the runner opens; it is what a slice uses until its module's services
 * exist. A `SERVICE` unit writes through the modules' published services in the running application, as the seeded
 * staff, so every rule, audit event and outbox message is the one production writes (A-085).
 */
export type SeedUnit = SqlSeedUnit | ServiceSeedUnit;

export interface SqlSeedUnit {
  readonly kind: 'SQL';
  readonly name: string;
  run(client: pg.PoolClient): Promise<{ readonly records: number }>;
}

export interface ServiceSeedUnit {
  readonly kind: 'SERVICE';
  readonly name: string;
  run(app: INestApplicationContext): Promise<{ readonly records: number }>;
}
