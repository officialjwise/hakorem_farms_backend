import { createUuidV7Generator, systemClock } from '@hakorem/kernel';
import type { INestApplicationContext } from '@nestjs/common';
import type pg from 'pg';
import { Approvals } from '../modules/iam';
import { PriceListAdmin, Promotions, TaxAdmin, type TaxCellRequest } from '../modules/mdm';
import { UnitOfWork } from '../platform/database/unit-of-work';
import { PG_POOL } from '../platform/platform.module';
import { SEED_CUSTOMERS, SEED_PRICE_LISTS, SEED_PROMOTIONS, SEED_TAX_SCHEME } from './reference-pricing';
import { SeedStaff } from './seed-staff';
import type { ServiceSeedUnit } from './seed-unit';

/** The instant the seeded farm's prices and tax scheme take effect. */
export const SEED_INSTANT = new Date('2026-11-01T06:00:00Z');
const TIER: Readonly<Record<string, string>> = {
  RETAIL: '01900000-0000-7000-8000-000000000301',
  WHOLESALE: '01900000-0000-7000-8000-000000000302',
  RESELLER: '01900000-0000-7000-8000-000000000303',
};
/** The tax categories (migration 0009) and levies (migration 0014), by code. */
const TAX_CATEGORY: Readonly<Record<string, string>> = {
  LIVE_ANIMALS: '01900000-0000-7000-8000-000000000201',
  RAW_PRODUCE: '01900000-0000-7000-8000-000000000202',
  EGGS: '01900000-0000-7000-8000-000000000203',
  PROCESSED_MEAT: '01900000-0000-7000-8000-000000000204',
  FARM_INPUTS: '01900000-0000-7000-8000-000000000205',
  DELIVERY_SERVICE: '01900000-0000-7000-8000-000000000206',
  OTHER_GOODS: '01900000-0000-7000-8000-000000000207',
};
const LEVY: Readonly<Record<string, string>> = {
  VAT: '01900000-0000-7000-8000-000000000501',
  NHIL: '01900000-0000-7000-8000-000000000502',
  GETFUND: '01900000-0000-7000-8000-000000000503',
};

/** A key that is the same on every run, so a second run replays instead of writing twice. */
const key = (...parts: string[]): string => `seed:${parts.join(':')}`;

function required(map: ReadonlyMap<string, string>, code: string, what: string): string {
  const value = map.get(code);
  if (value === undefined) {
    throw new Error(`the MDM seed needs ${what} ${code}, which an earlier seed unit creates; run the seed units in order`);
  }
  return value;
}

async function idsByCode(pool: pg.Pool, sql: string): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ code: string; id: string }>(sql);
  return new Map(rows.map((row) => [row.code, row.id]));
}

/** The ADR-0020 matrix as `replaceTaxSchemeCells` takes it: one cell for every tax category and levy. */
export function seedTaxCells(): TaxCellRequest[] {
  return Object.entries(TAX_CATEGORY).flatMap(([category, taxCategoryId]) =>
    SEED_TAX_SCHEME.levies.map((levy, index): TaxCellRequest => {
      const standard = SEED_TAX_SCHEME.standardCategories.includes(category);
      return {
        taxCategoryId,
        levyId: LEVY[levy.code]!,
        treatment: standard ? 'STANDARD' : 'ZERO_RATED',
        ratePercent: standard ? levy.ratePercent : '0',
        baseKind: 'NET',
        isReclaimable: true,
        calcOrder: index + 1,
      };
    }),
  );
}

/**
 * The MDM slice of the seeded farm written through MDM's services as the seeded staff (A-085): tax scheme version 1
 * drafted by the seeded Accountant and approved by the seeded Owner; every price list of `reference-pricing.ts`
 * drafted by the seeded Manager and approved by the seeded Owner; and the seeded promotions, drafted by the Manager
 * and approved by the Owner. A record already there (found by its code) is left alone, so a second run writes
 * nothing; every call also carries a fixed idempotency key.
 */
export function farmSeedMdm(): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'mdm-services',
    async run(app: INestApplicationContext) {
      const staff = await SeedStaff.load(app);
      const pool = app.get<pg.Pool>(PG_POOL);
      const uow = app.get(UnitOfWork);
      const approvals = app.get(Approvals);
      const approve = (approvalRequestId: string, reason: string) =>
        staff.as('owner', (owner) => uow.run({ isolation: 'serializable' }, (tx) => approvals.decide(tx, owner, approvalRequestId, 'APPROVED', reason)));
      const nextId = createUuidV7Generator(systemClock);
      let records = 0;

      // Tax scheme version 1 (ADR-0020, ADR-0039): the Accountant drafts and submits, the Owner approves.
      const tax = app.get(TaxAdmin);
      const schemes = await pool.query('SELECT 1 FROM mdm.tax_scheme_version LIMIT 1');
      if (schemes.rows.length === 0) {
        const pending = await staff.as('accountant', async (accountant) => {
          const created = await tax.createVersion(accountant, { validFrom: SEED_INSTANT.toISOString().slice(0, 10), sourceNote: SEED_TAX_SCHEME.sourceNote }, key('tax', 'v1'));
          const filled = await tax.replaceCells(accountant, created.body.id, { version: created.body.version, cells: seedTaxCells() }, key('tax', 'v1', 'cells'));
          return tax.submit(accountant, filled.body.id, key('tax', 'v1', 'submit'));
        });
        await approve(pending.body.approvalRequestId, 'Rates as ADR-0020 sets them (SEED)');
        records += 1 + seedTaxCells().length;
      }

      // Price lists, each with version 1: the Manager drafts and submits, the Owner approves.
      const priceLists = app.get(PriceListAdmin);
      const existingLists = await idsByCode(pool, 'SELECT code, id FROM mdm.price_list WHERE deleted_at IS NULL');
      const products = await idsByCode(pool, 'SELECT sku AS code, id FROM mdm.product WHERE deleted_at IS NULL');
      const grades = await idsByCode(pool, 'SELECT s.code || \':\' || g.code AS code, g.id FROM mdm.grade g JOIN mdm.species s ON s.id = g.species_id WHERE g.deleted_at IS NULL');
      const bands = await idsByCode(pool, 'SELECT code, id FROM mdm.weight_band WHERE deleted_at IS NULL');
      const productSpecies = await idsByCode(pool, 'SELECT p.sku AS code, s.code AS id FROM mdm.product p JOIN mdm.species s ON s.id = p.species_id WHERE p.deleted_at IS NULL');
      for (const list of SEED_PRICE_LISTS) {
        if (existingLists.has(list.code)) {
          continue;
        }
        const pending = await staff.as('manager', async (manager) => {
          const created = await priceLists.createList(
            manager,
            { code: list.code, name: list.name, kind: list.kind, channel: list.channel ?? undefined, customerTierId: list.tier === null ? undefined : TIER[list.tier], taxInclusive: true },
            key('price-list', list.code),
          );
          existingLists.set(list.code, created.body.id);
          const version = await priceLists.createVersion(manager, created.body.id, { validFrom: SEED_INSTANT, notes: 'SEED opening prices' }, key('price-list', list.code, 'v1'));
          const entries = list.entries.map((entry) => ({
            productId: required(products, entry.sku, 'product'),
            gradeId: entry.grade === null ? undefined : required(grades, `${required(productSpecies, entry.sku, 'the species of product')}:${entry.grade}`, 'grade'),
            weightBandId: entry.band === null ? undefined : required(bands, entry.band, 'weight band'),
            basis: entry.basis,
            listPricePesewas: entry.list,
            floorPricePesewas: entry.floor,
            ceilingPricePesewas: entry.ceiling,
            quoteOnly: entry.quoteOnly,
          }));
          const filled = await priceLists.replaceEntries(manager, version.body.id, { version: version.body.version, entries }, key('price-list', list.code, 'v1', 'entries'));
          return priceLists.submit(manager, filled.body.id, key('price-list', list.code, 'v1', 'submit'));
        });
        await approve(pending.body.approvalRequestId, 'Opening prices (SEED)');
        records += 2 + list.entries.length;
      }

      // The caterer's contract list. Written as SQL until assignCustomerPriceList is built (A-085).
      const customers = await idsByCode(pool, 'SELECT customer_no AS code, id FROM mdm.customer WHERE deleted_at IS NULL');
      const manager = staff.actor('manager').principalId;
      for (const customer of SEED_CUSTOMERS) {
        if (customer.assignedList === null) {
          continue;
        }
        const assigned = await pool.query(
          `INSERT INTO mdm.customer_price_list (id, customer_id, price_list_id, valid_from, created_by, updated_by)
           SELECT $1, $2, $3, $4, $5, $5 WHERE NOT EXISTS (SELECT 1 FROM mdm.customer_price_list WHERE customer_id = $2 AND deleted_at IS NULL)`,
          [nextId(), required(customers, customer.customerNo, 'customer'), required(existingLists, customer.assignedList, 'price list'), SEED_INSTANT, manager],
        );
        records += assigned.rowCount ?? 0;
      }

      // Promotions: the Manager drafts, adds the coupon and submits; the Owner approves.
      const promotions = app.get(Promotions);
      const existingPromotions = await idsByCode(pool, 'SELECT code, id FROM mdm.promotion');
      const categories = await idsByCode(pool, 'SELECT code, id FROM mdm.category WHERE deleted_at IS NULL');
      for (const promotion of SEED_PROMOTIONS) {
        if (existingPromotions.has(promotion.code)) {
          continue;
        }
        const pending = await staff.as('manager', async (manager) => {
          const created = await promotions.create(
            manager,
            {
              code: promotion.code,
              name: promotion.name,
              kind: 'PERCENT_OFF',
              percentOff: promotion.percentOff,
              appliesTo: 'LINE',
              channel: promotion.channel,
              stackGroup: promotion.stackGroup,
              requiresCoupon: promotion.coupon !== null,
              validFrom: SEED_INSTANT,
              validTo: promotion.validTo,
              targets: [{ categoryId: required(categories, promotion.category, 'category') }],
            },
            key('promotion', promotion.code),
          );
          if (promotion.coupon !== null) {
            await promotions.createCoupon(manager, created.body.id, promotion.coupon, key('promotion', promotion.code, 'coupon'));
            records += 1;
          }
          return promotions.submit(manager, created.body.id, key('promotion', promotion.code, 'submit'));
        });
        await approve(pending.body.approvalRequestId, 'Seeded promotion (SEED)');
        records += 1;
      }
      return { records };
    },
  };
}
