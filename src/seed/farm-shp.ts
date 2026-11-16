import type { INestApplicationContext } from '@nestjs/common';
import { toBusinessDate, type Clock } from '@hakorem/kernel';
import type pg from 'pg';
import { Slots } from '../modules/del';
import { CatalogueListing } from '../modules/shp';
import { CLOCK, PG_POOL } from '../platform/platform.module';
import { SEED_DELIVERY_ZONE } from './farm-mdm';
import { SeedStaff } from './seed-staff';
import type { ServiceSeedUnit } from './seed-unit';

/** Dodowa's delivery slots (FR-DEL-001, SEED): Tuesdays, Thursdays and Saturdays, a morning and an afternoon run of 8. */
export const SEED_SLOTS = {
  days: 14,
  weekdays: [2, 4, 6],
  times: [
    { startsAt: '10:00', endsAt: '12:00', capacity: 8 },
    { startsAt: '14:00', endsAt: '16:00', capacity: 8 },
  ],
} as const;

const MS_PER_DAY = 86_400_000;

/**
 * The online store's seed (B07 continued 2): the Manager generates Dodowa's delivery slots for the coming fortnight
 * through DEL's `Slots`, and the storefront's listing is built through SHP's `CatalogueListing` from the seeded
 * catalogue, prices and stock. No stock moves and no reservation is made, so the B5 and B05x hand counts are unchanged.
 * A second run adds no slot (each start is unique) and rebuilds the same listing.
 */
export function farmSeedShp(): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'shp-storefront',
    async run(app: INestApplicationContext) {
      const staff = await SeedStaff.load(app);
      const pool = app.get<pg.Pool>(PG_POOL);
      const zone = (await pool.query<{ id: string }>('SELECT id FROM mdm.delivery_zone WHERE code = $1 AND deleted_at IS NULL', [SEED_DELIVERY_ZONE.code])).rows[0];
      if (zone === undefined) throw new Error('the storefront seed needs the Dodowa delivery zone, which the MDM seed unit creates; run the seed units in order');
      const now = app.get<Clock>(CLOCK).now();
      const from = toBusinessDate(now);
      const to = toBusinessDate(new Date(now.getTime() + (SEED_SLOTS.days - 1) * MS_PER_DAY));
      const existing = Number((await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM del.delivery_slot WHERE delivery_zone_id = $1 AND slot_date BETWEEN $2 AND $3', [zone.id, from, to])).rows[0]!.n);
      const created =
        existing > 0
          ? 0
          : (
              await staff.as('manager', (manager) =>
                app.get(Slots).generate(manager, { zoneId: zone.id, from, to, weekdays: [...SEED_SLOTS.weekdays], times: SEED_SLOTS.times.map((t) => ({ ...t })) }, `seed:shp:slots:${from}`),
              )
            ).body.created;
      const before = Number((await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM shp.product_listing')).rows[0]!.n);
      const listed = await app.get(CatalogueListing).refresh();
      // A rebuild of a listing that already exists writes the same rows: it is not counted as new seed records.
      return { records: created + (before === 0 ? listed.listed : 0) };
    },
  };
}
