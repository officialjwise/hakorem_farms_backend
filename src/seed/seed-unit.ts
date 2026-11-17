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

/**
 * The seed names each product by the SKU the server gives it in seed order (B09q, ADR-0072), since a SKU is never
 * sent. A product that came back with another one means the catalogue held products of that prefix before the seed
 * ran, and every later seed unit would find the wrong product: stop with what to do instead.
 */
export function expectSeededSku(given: string, expected: string): void {
  if (given !== expected) {
    throw new Error(`the seed expected the server to give SKU ${expected} and it gave ${given}: seed a fresh database, whose SKU counters start at 1`);
  }
}
