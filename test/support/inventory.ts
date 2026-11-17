import { randomUUID } from 'node:crypto';
import { toBusinessDate } from '@hakorem/kernel';
import type pg from 'pg';
import { createCatalogue, TAX_CATEGORY } from './catalogue';
import { createBranch, SYSTEM_PRINCIPAL } from './iam';
import type { TestDatabase } from './test-database';

/**
 * The business date in Accra `offsetDays` from now, on the same clock `move` dates a movement by: a lot's produced and
 * expiry dates built from it stay on the right side of "today" whenever the suite runs, never a fixed calendar date.
 */
export function businessDay(offsetDays: number): string {
  return toBusinessDate(new Date(Date.now() + offsetDays * 86_400_000));
}

/** The virtual locations ADR-0002 models the outside world with. */
export const VIRTUAL = ['SUPPLIER', 'CUSTOMER', 'PRODUCTION', 'PROCESSING', 'CONSUMPTION', 'LOSS', 'ADJUSTMENT', 'OPENING'] as const;
export type VirtualKind = (typeof VIRTUAL)[number];

/**
 * A branch with the locations a stock test needs, made in SQL as the seed's services would make them: a shop floor
 * that is sellable and allows negative stock (the offline case, FR-INV-019), a store that does not, a cold room, the
 * goat pens, in-transit, and the eight virtual locations; three products, one per archetype. A second branch has a
 * shop and its own virtual locations, for transfers between branches.
 */
export interface StockFixture {
  readonly app: pg.Pool;
  readonly branchId: string;
  readonly otherBranchId: string;
  readonly shop: string;
  readonly store: string;
  readonly coldRoom: string;
  readonly pens: string;
  readonly inTransit: string;
  readonly otherShop: string;
  readonly virtual: Readonly<Record<VirtualKind, string>>;
  readonly otherVirtual: Readonly<Record<VirtualKind, string>>;
  /** Serialised live goats, one stock unit per animal. */
  readonly goat: string;
  /** Countable crates of eggs, untracked: one weighted-average pool per branch. */
  readonly eggs: string;
  /** Catch-weight beef in kilogram lots. */
  readonly beef: string;
  /** Eggs counted one by one and held in lots, one per delivery (B09e): the crate of 30 is how they are sold, not stored. */
  readonly eggLots: string;
  readonly actor: string;
}

async function location(app: pg.Pool, branchId: string, code: string, kind: string, flags: { virtual?: boolean; sellable?: boolean; negative?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await app.query(
    `INSERT INTO mdm.location (id, branch_id, code, name, kind, is_virtual, is_sellable, allows_negative, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
    [id, branchId, code, `${code} location`, kind, flags.virtual ?? false, flags.sellable ?? false, flags.negative ?? false, SYSTEM_PRINCIPAL],
  );
  return id;
}

async function virtuals(app: pg.Pool, branchId: string): Promise<Record<VirtualKind, string>> {
  const out = {} as Record<VirtualKind, string>;
  for (const kind of VIRTUAL) {
    out[kind] = await location(app, branchId, `V-${kind}`, kind, { virtual: true, negative: kind !== 'CUSTOMER' });
  }
  return out;
}

async function product(app: pg.Pool, fields: { sku: string; categoryId: string; policy: string; tracking: string; speciesId?: string | null; uom: string; gl: string; tax: string }): Promise<string> {
  const id = randomUUID();
  await app.query(
    `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, species_id, base_uom, sale_uom, tax_category_id, gl_group, online_mode, status, created_by, updated_by)
     VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $7, $8, $9, 'HIDDEN', 'ACTIVE', $10, $10)`,
    [id, fields.sku, fields.categoryId, fields.policy, fields.tracking, fields.speciesId ?? null, fields.uom, fields.tax, fields.gl, SYSTEM_PRINCIPAL],
  );
  return id;
}

export async function createStockFixture(database: TestDatabase): Promise<StockFixture> {
  const app = database.pool('app');
  const { branchId } = await createBranch(database, 'DDW');
  const { branchId: otherBranchId } = await createBranch(database, 'ACC');
  const catalogue = await createCatalogue(database);
  const actor = randomUUID();
  await app.query("INSERT INTO iam.principal (id, kind, display_name, status, created_by, updated_by) VALUES ($1, 'USER', 'Kwame Mensah', 'ACTIVE', $2, $2)", [
    actor,
    SYSTEM_PRINCIPAL,
  ]);
  return {
    app,
    branchId,
    otherBranchId,
    shop: await location(app, branchId, 'SHOP-FLOOR', 'SHOP_FLOOR', { sellable: true, negative: true }),
    store: await location(app, branchId, 'STORE', 'STORE'),
    coldRoom: await location(app, branchId, 'COLD-1', 'COLD_ROOM'),
    pens: await location(app, branchId, 'PEN-2', 'PEN'),
    inTransit: await location(app, branchId, 'TRANSIT', 'IN_TRANSIT'),
    otherShop: await location(app, otherBranchId, 'SHOP-FLOOR', 'SHOP_FLOOR', { sellable: true }),
    virtual: await virtuals(app, branchId),
    otherVirtual: await virtuals(app, otherBranchId),
    goat: await product(app, { sku: 'LIV-0004', categoryId: catalogue.liveCategoryId, policy: 'SERIALISED', tracking: 'SERIAL', speciesId: catalogue.goatSpeciesId, uom: 'HEAD', gl: 'LIVE_ANIMALS', tax: TAX_CATEGORY.LIVE_ANIMALS }),
    eggs: await product(app, { sku: 'EGG-0003', categoryId: catalogue.eggsCategoryId, policy: 'COUNTABLE', tracking: 'NONE', uom: 'CRATE', gl: 'PRODUCE_EGGS', tax: TAX_CATEGORY.EGGS }),
    beef: await product(app, { sku: 'MEAT-BEEF-15', categoryId: catalogue.meatCategoryId, policy: 'CATCH_WEIGHT', tracking: 'LOT', uom: 'KG', gl: 'MEAT', tax: TAX_CATEGORY.PROCESSED_MEAT }),
    eggLots: await product(app, { sku: 'EGG-LOT-0001', categoryId: catalogue.eggsCategoryId, policy: 'COUNTABLE', tracking: 'LOT', uom: 'UNIT', gl: 'PRODUCE_EGGS', tax: TAX_CATEGORY.EGGS }),
    actor,
  };
}

/** A business document for a movement to name as its source. */
export async function stockDocument(fx: StockFixture, type = 'STOCK_ADJUSTMENT', branchId = fx.branchId): Promise<string> {
  const id = randomUUID();
  await fx.app.query('INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, $2, $3, $4, $5)', [
    id,
    type,
    'inv',
    branchId,
    fx.actor,
  ]);
  return id;
}

/** A stock unit: an animal by its tag, or a lot by its batch number. */
export async function stockUnit(
  fx: StockFixture,
  fields: { productId: string; tracking: 'SERIAL' | 'LOT'; identifier: string; branchId?: string; producedOn?: string | null; expiresOn?: string | null; supplierId?: string | null },
): Promise<string> {
  const id = randomUUID();
  await fx.app.query(
    `INSERT INTO inv.stock_unit (id, product_id, tracking, branch_id, identifier, status, produced_on, expires_on, supplier_id, source_document_id, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7, $8, $9, $10, $10)`,
    [id, fields.productId, fields.tracking, fields.branchId ?? fx.branchId, fields.identifier, fields.producedOn ?? null, fields.expiresOn ?? null, fields.supplierId ?? null, await stockDocument(fx, 'GOODS_RECEIPT'), fx.actor],
  );
  return id;
}

export interface MovementFields {
  readonly type: string;
  readonly productId: string;
  readonly from: string;
  readonly to: string;
  readonly qty: string;
  readonly value?: number;
  readonly unitId?: string | null;
  readonly branchId?: string;
  readonly weightKg?: string | null;
  readonly weightSource?: string | null;
  readonly costElement?: string | null;
  readonly reason?: string | null;
  readonly reservationId?: string | null;
  readonly reverses?: string | null;
  readonly occurredAt?: Date;
  readonly documentId?: string;
}

/** Inserts one movement straight in SQL as hk_app, as any script could: the database alone decides. */
export async function move(fx: StockFixture, m: MovementFields, client: pg.Pool | pg.PoolClient = fx.app): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO inv.stock_movement (id, movement_type, product_id, stock_unit_id, branch_id, from_location_id, to_location_id, qty_base, weight_kg,
                                     weight_source, value_pesewas, cost_element, reason_code, source_document_id, reservation_id, reverses_movement_id,
                                     occurred_at, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      id,
      m.type,
      m.productId,
      m.unitId ?? null,
      m.branchId ?? fx.branchId,
      m.from,
      m.to,
      m.qty,
      m.weightKg ?? null,
      m.weightSource ?? null,
      m.value ?? 0,
      m.costElement !== undefined ? m.costElement : (m.value ?? 0) > 0 ? 'PURCHASE' : null,
      m.reason ?? null,
      m.documentId ?? (await stockDocument(fx)),
      m.reservationId ?? null,
      m.reverses ?? null,
      m.occurredAt ?? new Date(),
      fx.actor,
    ],
  );
  return id;
}

/** A receipt from the supplier into a physical location, with its value. */
export function receive(fx: StockFixture, productId: string, to: string, qty: string, value: number, unitId: string | null = null): Promise<string> {
  return move(fx, { type: 'RECEIPT_PURCHASE', productId, from: fx.virtual.SUPPLIER, to, qty, value, unitId });
}

/** A counter sale from a physical location to the customer. */
export function sell(fx: StockFixture, productId: string, from: string, qty: string, unitId: string | null = null, extra: Partial<MovementFields> = {}): Promise<string> {
  return move(fx, { type: 'SALE_ISSUE', productId, from, to: fx.virtual.CUSTOMER, qty, unitId, ...extra });
}

export async function onHand(fx: StockFixture, productId: string, locationId: string, unitId: string | null = null): Promise<string | null> {
  const { rows } = await fx.app.query<{ on_hand_qty: string }>(
    'SELECT on_hand_qty FROM inv.stock_balance WHERE product_id = $1 AND stock_unit_id IS NOT DISTINCT FROM $2 AND location_id = $3',
    [productId, unitId, locationId],
  );
  return rows[0]?.on_hand_qty ?? null;
}

export async function pool(fx: StockFixture, productId: string, unitId: string | null = null, branchId = fx.branchId): Promise<{ qty: string; value: string } | null> {
  const { rows } = await fx.app.query<{ qty: string; value_pesewas: string }>(
    'SELECT qty, value_pesewas FROM inv.cost_pool WHERE product_id = $1 AND stock_unit_id IS NOT DISTINCT FROM $2 AND branch_id = $3',
    [productId, unitId, branchId],
  );
  return rows[0] === undefined ? null : { qty: rows[0].qty, value: rows[0].value_pesewas };
}

export async function movementValue(fx: StockFixture, id: string): Promise<string> {
  const { rows } = await fx.app.query<{ value_pesewas: string }>('SELECT value_pesewas FROM inv.stock_movement WHERE id = $1', [id]);
  return rows[0]!.value_pesewas;
}

/** The rule a stock refusal names (SQLSTATE HK010), or the SQLSTATE of any other failure; undefined on success. */
export async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (error: { code?: string; constraint?: string }) => (error.code === 'HK010' ? error.constraint : error.code),
  );
}
