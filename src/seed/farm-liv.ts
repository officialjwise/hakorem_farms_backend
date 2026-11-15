import type { INestApplicationContext } from '@nestjs/common';
import type pg from 'pg';
import { Weighing } from '../modules/liv';
import { PG_POOL } from '../platform/platform.module';
import { SeedStaff } from './seed-staff';
import type { ServiceSeedUnit } from './seed-unit';

/** When the seeded animals were first weighed: an hour after they came off the lorry. */
export const SEED_WEIGHED_AT = new Date('2026-11-10T08:00:00Z');

/**
 * The first weighing of the seeded animals at Dodowa's pens (FR-LIV-004), SEED: West African Dwarf goats of 19 to 27
 * kg and Djallonke sheep near 30 kg on the scale, and a sample of ten of the twenty broilers, averaging 1.850 kg a
 * bird. Fixed client ids, so a second run counts each as a duplicate and records nothing. The register itself needs
 * no seed: receiving the animals opened them (inv.StockUnitRegistered). Weights change neither stock nor cost.
 */
export const SEED_WEIGHINGS = [
  { id: '019a6c5a-6dc0-7000-8000-00000000a001', tag: 'G-0142', weightKg: '24.350', headWeighed: 1 },
  { id: '019a6c5a-6dc0-7000-8000-00000000a002', tag: 'G-0143', weightKg: '22.800', headWeighed: 1 },
  { id: '019a6c5a-6dc0-7000-8000-00000000a003', tag: 'G-0144', weightKg: '26.100', headWeighed: 1 },
  { id: '019a6c5a-6dc0-7000-8000-00000000a004', tag: 'G-0145', weightKg: '19.750', headWeighed: 1 },
  { id: '019a6c5a-6dc0-7000-8000-00000000a005', tag: 'S-0031', weightKg: '31.200', headWeighed: 1 },
  { id: '019a6c5a-6dc0-7000-8000-00000000a006', tag: 'S-0032', weightKg: '28.650', headWeighed: 1 },
  { id: '019a6c5a-6dc0-7000-8000-00000000a007', tag: 'BR-2026-1110', weightKg: '1.850', headWeighed: 10 },
] as const;

/**
 * The LIV slice of the seeded farm, written through `Weighing` as the seeded Manager (A-085). Feed, medicine, a store
 * and rations are seeded with batches in B06 continued 2 (A-158), so that the B5 and B05x hand counts are counted
 * again once, with them.
 */
export function farmSeedLiv(): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'liv-services',
    async run(app: INestApplicationContext) {
      const staff = await SeedStaff.load(app);
      const pool = app.get<pg.Pool>(PG_POOL);
      const units = new Map((await pool.query<{ identifier: string; id: string }>('SELECT identifier, id FROM inv.stock_unit')).rows.map((r) => [r.identifier, r.id]));
      const recorded = new Set((await pool.query<{ id: string }>('SELECT id FROM liv.weight_record WHERE id = ANY($1::uuid[])', [SEED_WEIGHINGS.map((w) => w.id)])).rows.map((r) => r.id));
      const fresh = SEED_WEIGHINGS.filter((w) => !recorded.has(w.id));
      if (fresh.length === 0) return { records: 0 };
      const records = fresh.map((w) => {
        const stockUnitId = units.get(w.tag);
        if (stockUnitId === undefined) throw new Error(`the LIV seed needs ${w.tag}, which the INV seed receives; run the seed units in order`);
        return { id: w.id, stockUnitId, weightKg: w.weightKg, weightSource: 'SCALE' as const, headWeighed: w.headWeighed, measuredAt: SEED_WEIGHED_AT };
      });
      return staff.as('manager', async (manager) => {
        const result = await app.get(Weighing).record(manager, records, `seed:liv:first-weighing:${fresh.map((w) => w.id.slice(-4)).join('-')}`);
        return { records: result.body.accepted };
      });
    },
  };
}
