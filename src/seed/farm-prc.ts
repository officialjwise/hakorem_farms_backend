import type { INestApplicationContext } from '@nestjs/common';
import type pg from 'pg';
import { YieldStandards } from '../modules/prc';
import { PG_POOL } from '../platform/platform.module';
import { SeedStaff } from './seed-staff';
import type { ServiceSeedUnit } from './seed-unit';

/**
 * Yield standards at the farm (FR-PRC-004), SEED: a dressed West African Dwarf goat gives about 48 percent of its live
 * weight as meat and 11 percent as offal; outside 5 percent of either, a processing order is flagged for
 * investigation. Configured data the owner replaces.
 */
export const SEED_YIELD_STANDARDS = [
  { input: 'LIV-GOAT', output: 'MEAT-GOAT-15KG', expectedPercent: '48', tolerancePercent: '5' },
  { input: 'LIV-GOAT', output: 'BYP-GOAT-OFFAL', expectedPercent: '11', tolerancePercent: '5' },
] as const;

const key = (...parts: string[]): string => `seed:prc:${parts.join(':')}`;

/**
 * The PRC slice of the seeded farm, written through `YieldStandards` as the seeded Manager (A-085). A standard already
 * there is left alone. No processing order is seeded: completing one would change the stock the B5 and B05x gates
 * count by hand, so the farm keeps its goats and the tests process their own.
 */
export function farmSeedPrc(): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'prc-services',
    async run(app: INestApplicationContext) {
      const staff = await SeedStaff.load(app);
      const pool = app.get<pg.Pool>(PG_POOL);
      const products = new Map((await pool.query<{ sku: string; id: string }>('SELECT sku, id FROM mdm.product WHERE deleted_at IS NULL')).rows.map((r) => [r.sku, r.id]));
      const standards = app.get(YieldStandards);
      return staff.as('manager', async (manager) => {
        const existing = (await standards.list(manager, undefined, 100)).data.map((s) => `${s.inputProduct.sku}>${s.outputProduct.sku}`);
        let written = 0;
        for (const standard of SEED_YIELD_STANDARDS) {
          if (existing.includes(`${standard.input}>${standard.output}`)) continue;
          const inputProductId = products.get(standard.input);
          const outputProductId = products.get(standard.output);
          if (inputProductId === undefined || outputProductId === undefined) {
            throw new Error(`the PRC seed needs products ${standard.input} and ${standard.output}, which the MDM seed creates; run the seed units in order`);
          }
          await standards.create(manager, { inputProductId, outputProductId, expectedPercent: standard.expectedPercent, tolerancePercent: standard.tolerancePercent }, key('yield', standard.input, standard.output));
          written += 1;
        }
        return { records: written };
      });
    },
  };
}
