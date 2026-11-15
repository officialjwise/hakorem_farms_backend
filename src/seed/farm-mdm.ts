import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type pg from 'pg';
import { Approvals } from '../modules/iam';
import { CatalogueAdmin, LocationsAdmin, PartiesAdmin, PriceListAdmin, ProductCatalogue, Promotions, ReferenceDataAdmin, TaxAdmin, type TaxCellRequest } from '../modules/mdm';
import { runWithRequestContext, type Actor } from '../platform/context/request-context';
import { UnitOfWork } from '../platform/database/unit-of-work';
import { PG_POOL } from '../platform/platform.module';
import { SEED_CATEGORIES, SEED_SPECIES_LIST } from './reference-catalogue';
import { SEED_CUSTOMERS, SEED_PRICE_LISTS, SEED_PRODUCTS, SEED_PROMOTIONS, SEED_SPECIES, SEED_TAX_SCHEME } from './reference-pricing';
import { SEED_USER_AGENT, SeedStaff } from './seed-staff';
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

/** The payment methods the seeded farm takes (A-115). Cheques and store credit stay disabled until the owner decides. */
export const SEED_PAYMENT_METHODS_ENABLED: readonly string[] = ['CASH', 'MOMO', 'CARD', 'BANK_TRANSFER', 'COD'];
/** Dodowa's delivery zone: GHS 15.00, free over GHS 500.00, orders by 14:00 for the next slot (FR-MDM-010). */
export const SEED_DELIVERY_ZONE = {
  code: 'DODOWA',
  name: 'Dodowa and surroundings (SEED)',
  areas: ['Dodowa', 'Ayikuma', 'Afienya', 'Doryumu'],
  feePesewas: 1_500n,
  freeOverPesewas: 50_000n,
  cutoffTime: '14:00',
} as const;

/** Default shelf lives of new lots: frozen meat packs and eggs (reference catalogue). */
const MEAT_SHELF_LIFE_DAYS = 90;
const EGG_SHELF_LIFE_DAYS = 21;

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

/** The farm's first branch: the Dodowa farm and shop (A-001: one location running from day one). */
const DODOWA = { code: 'DDW', name: 'Dodowa farm and shop (SEED)', address: 'Off the Dodowa-Afienya road, Dodowa, GE-293-0471 (SEED)', phone: '+233200000001' };
const SYSTEM_PRINCIPAL = '01900000-0000-7000-8000-000000000001';

/** Dodowa's physical locations, the site first; the others sit below it. The frozen cold room carries its range. */
const DODOWA_LOCATIONS = [
  { code: 'SITE', name: 'Farm site', kind: 'SITE' },
  { code: 'PENS', name: 'Goat and sheep pens', kind: 'PEN', capacityHead: 120 },
  { code: 'COLD', name: 'Cold room', kind: 'COLD_ROOM', tempClass: 'FROZEN', tempMinC: '-25.0', tempMaxC: '-18.0' },
  { code: 'SHOP', name: 'Shop floor', kind: 'SHOP_FLOOR', isSellable: true },
  { code: 'VAN1', name: 'Delivery van GT 4471-26 (SEED)', kind: 'VEHICLE' },
  { code: 'RETURNS', name: 'Customer returns holding area', kind: 'RETURNS_HOLD' },
  // Where a transfer's stock waits between dispatch and receipt: still the farm's stock (FR-INV-010).
  { code: 'TRANSIT', name: 'Stock in transit', kind: 'IN_TRANSIT' },
] as const;

/**
 * The first seed unit: the Dodowa branch with its eight virtual locations, through MDM's bootstrap (ADR-0042). A
 * role grant names a branch, so the first branch exists before anyone can be granted anything; the bootstrap runs
 * as the SYSTEM principal and only while no branch exists. Every later branch is created by a granted person.
 */
export function farmSeedMdmBootstrap(): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'mdm-bootstrap',
    async run(app: INestApplicationContext) {
      const pool = app.get<pg.Pool>(PG_POOL);
      if ((await pool.query('SELECT 1 FROM mdm.branch LIMIT 1')).rows.length > 0) {
        return { records: 0 };
      }
      const system: Actor = { principalId: SYSTEM_PRINCIPAL, kind: 'SYSTEM', displayName: 'System', realm: null, sessionId: null, steppedUpAt: null };
      await runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: SEED_USER_AGENT, actor: system }, () =>
        app.get(LocationsAdmin).bootstrapFirstBranch(system, DODOWA),
      );
      return { records: 9 };
    },
  };
}

/**
 * The MDM slice of the seeded farm written through MDM's services as the seeded staff (A-085): the catalogue's
 * categories, species, grades, weight bands and products, written by the seeded Manager; tax scheme version 1
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
      let records = 0;

      // The smoke-suite branch, created by the Owner; it gets its virtual locations with it. Its physical locations
      // wait for B13's smoke suite and a person granted there (A-110).
      const locationsAdmin = app.get(LocationsAdmin);
      const branchIds = await idsByCode(pool, 'SELECT code, id FROM mdm.branch');
      if (!branchIds.has('TST')) {
        await staff.as('owner', (owner) =>
          locationsAdmin.createBranch(owner, { code: 'TST', name: 'Smoke test branch (SEED)', address: DODOWA.address, phone: DODOWA.phone }, key('branch', 'TST'), { isTest: true }),
        );
        records += 9;
      }

      // Dodowa's physical locations, created by the Manager, who is granted at Dodowa.
      const dodowa = required(branchIds, 'DDW', 'branch');
      const locationIds = await idsByCode(pool, "SELECT l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.deleted_at IS NULL");
      records += await staff.as('manager', async (manager) => {
        let written = 0;
        for (const location of DODOWA_LOCATIONS) {
          if (locationIds.has(location.code)) continue;
          const parentId = location.kind === 'SITE' ? undefined : required(locationIds, 'SITE', 'location');
          const created = await locationsAdmin.createLocation(manager, { branchId: dodowa, parentId, ...location }, key('location', 'DDW', location.code));
          locationIds.set(location.code, created.body.id);
          written += 1;
        }
        return written;
      });

      // The payment methods the farm takes, turned on by the Owner; cheques and store credit stay off (FR-MDM-009, A-115).
      const reference = app.get(ReferenceDataAdmin);
      const methods = await pool.query<{ id: string; code: string; version: number; is_enabled: boolean }>('SELECT id, code, version, is_enabled FROM mdm.payment_method');
      records += await staff.as('owner', async (owner) => {
        let written = 0;
        for (const method of methods.rows) {
          if (!SEED_PAYMENT_METHODS_ENABLED.includes(method.code) || method.is_enabled) continue;
          await reference.updatePaymentMethod(owner, method.id, { version: method.version, isEnabled: true }, key('payment-method', method.code));
          written += 1;
        }
        return written;
      });

      // Dodowa's delivery zone, created by the Manager before the customers, so a saved address finds it (FR-MDM-010).
      const zones = await idsByCode(pool, "SELECT z.code, z.id FROM mdm.delivery_zone z JOIN mdm.branch b ON b.id = z.branch_id WHERE b.code = 'DDW' AND z.deleted_at IS NULL");
      if (!zones.has(SEED_DELIVERY_ZONE.code)) {
        await staff.as('manager', (manager) => reference.createZone(manager, { branchId: dodowa, ...SEED_DELIVERY_ZONE }, key('delivery-zone', 'DDW', SEED_DELIVERY_ZONE.code)));
        records += 1;
      }

      // Customers, one per tier and a caterer, with their addresses, created by the Manager (FR-MDM-008).
      const parties = app.get(PartiesAdmin);
      const customers = await idsByCode(pool, 'SELECT name AS code, id FROM mdm.customer WHERE deleted_at IS NULL');
      records += await staff.as('manager', async (manager) => {
        let written = 0;
        for (const customer of SEED_CUSTOMERS) {
          if (customers.has(customer.name)) continue;
          const created = await parties.createCustomer(manager, { kind: customer.kind, name: customer.name, phone: customer.phone, tierId: TIER[customer.tier] }, key('customer', customer.customerNo));
          customers.set(customer.name, created.body.id);
          written += 1;
          if (customer.address !== null) {
            await parties.createAddress(
              manager,
              created.body.id,
              { ...customer.address, recipientName: customer.name, recipientPhone: customer.phone, isDefault: true },
              key('customer', customer.customerNo, 'address'),
            );
            written += 1;
          }
        }
        return written;
      });

      // The catalogue: categories, species, their grades and weight bands, and the products, written by the Manager.
      const catalogue = app.get(CatalogueAdmin);
      const productCatalogue = app.get(ProductCatalogue);
      const categories = await idsByCode(pool, 'SELECT code, id FROM mdm.category WHERE deleted_at IS NULL');
      const speciesIds = await idsByCode(pool, 'SELECT code, id FROM mdm.species WHERE deleted_at IS NULL');
      const grades = await idsByCode(pool, "SELECT s.code || ':' || g.code AS code, g.id FROM mdm.grade g JOIN mdm.species s ON s.id = g.species_id WHERE g.deleted_at IS NULL");
      const bands = await idsByCode(pool, 'SELECT code, id FROM mdm.weight_band WHERE deleted_at IS NULL');
      const products = await idsByCode(pool, 'SELECT sku AS code, id FROM mdm.product WHERE deleted_at IS NULL');
      records += await staff.as('manager', async (manager) => {
        let written = 0;
        for (const category of SEED_CATEGORIES) {
          if (categories.has(category.code)) continue;
          const created = await catalogue.createCategory(
            manager,
            { code: category.code, name: category.name, productLine: category.productLine, glGroup: category.glGroup, taxCategoryId: TAX_CATEGORY[category.taxCategory]!, sortOrder: category.sortOrder },
            key('category', category.code),
          );
          categories.set(category.code, created.body.id);
          written += 1;
        }
        for (const species of SEED_SPECIES_LIST) {
          if (speciesIds.has(species.code)) continue;
          speciesIds.set(species.code, (await catalogue.createSpecies(manager, species, key('species', species.code))).body.id);
          written += 1;
        }
        for (const species of SEED_SPECIES) {
          const speciesId = required(speciesIds, species.code, 'species');
          for (const [order, grade] of species.grades.entries()) {
            if (grades.has(`${species.code}:${grade.code}`)) continue;
            const created = await catalogue.createGrade(manager, { speciesId, code: grade.code, name: grade.name, description: grade.description, sortOrder: order }, key('grade', species.code, grade.code));
            grades.set(`${species.code}:${grade.code}`, created.body.id);
            written += 1;
          }
          for (const band of species.bands) {
            if (bands.has(band.code)) continue;
            bands.set(band.code, (await catalogue.createWeightBand(manager, { speciesId, code: band.code, minKg: band.minKg, maxKg: band.maxKg }, key('weight-band', band.code))).body.id);
            written += 1;
          }
        }
        for (const product of SEED_PRODUCTS) {
          if (products.has(product.sku)) continue;
          const meat = product.category === 'MEAT';
          const eggs = product.category === 'EGGS';
          const created = await productCatalogue.create(
            manager,
            {
              sku: product.sku,
              name: product.name,
              categoryId: required(categories, product.category, 'category'),
              stockPolicy: product.policy,
              speciesId: product.species === null ? undefined : required(speciesIds, product.species, 'species'),
              baseUom: product.baseUom,
              saleUom: product.saleUom,
              nominalPackKg: meat ? '15.000' : undefined,
              shelfLifeDays: meat ? MEAT_SHELF_LIFE_DAYS : eggs ? EGG_SHELF_LIFE_DAYS : undefined,
              storageTempClass: meat ? 'FROZEN' : eggs ? 'AMBIENT' : undefined,
              description: `SEED. ${product.name} from the reference catalogue.`,
              onlineMode: product.onlineMode,
            },
            key('product', product.sku),
          );
          products.set(product.sku, created.body.id);
          written += 1;
        }
        return written;
      });

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

      // The caterer's contract list, assigned by the Manager through assignCustomerPriceList (FR-MDM-021).
      const assigned = await idsByCode(pool, 'SELECT customer_id::text AS code, id FROM mdm.customer_price_list WHERE deleted_at IS NULL');
      for (const customer of SEED_CUSTOMERS) {
        const customerId = required(customers, customer.name, 'customer');
        if (customer.assignedList === null || assigned.has(customerId)) continue;
        await staff.as('manager', (manager) =>
          parties.assignPriceList(manager, customerId, { priceListId: required(existingLists, customer.assignedList!, 'price list'), validFrom: SEED_INSTANT }, key('customer', customer.customerNo, 'price-list')),
        );
        records += 1;
      }

      // Promotions: the Manager drafts, adds the coupon and submits; the Owner approves.
      const promotions = app.get(Promotions);
      const existingPromotions = await idsByCode(pool, 'SELECT code, id FROM mdm.promotion');
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
