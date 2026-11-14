import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ActiveWindow, EntryDefinition, EntryInput, EntryReferences, VersionWindow } from '../domain/price-list';
import type { Channel, PriceListKind } from '../domain/pricing-engine';
import type { EntrySnapshot, NewPriceList, PriceListRow, PriceListStore, VersionRow, VersionStatus } from '../application/price-list-store';

interface ListRecord {
  id: string;
  code: string;
  name: string;
  kind: PriceListKind;
  channel: Channel | null;
  tier_id: string | null;
  tier_code: string | null;
  tier_name: string | null;
  branch_id: string | null;
  branch_code: string | null;
  branch_name: string | null;
  tax_inclusive: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface VersionRecord {
  id: string;
  price_list_id: string;
  version_no: number;
  status: VersionStatus;
  valid_from: Date;
  valid_to: Date | null;
  approval_request_id: string | null;
  activated_at: Date | null;
  activated_by: string | null;
  notes: string | null;
  branch_id: string;
  entry_count: number;
  version: number;
  created_at: Date;
  created_by: string;
}

const VERSION_SELECT = `
  SELECT v.id, v.price_list_id, v.version_no, v.status, v.valid_from, v.valid_to, v.approval_request_id, v.activated_at, v.activated_by,
         v.notes, v.branch_id, v.version, v.created_at, v.created_by,
         (SELECT count(*)::int FROM mdm.price_list_entry e WHERE e.version_id = v.id) AS entry_count
    FROM mdm.price_list_version v`;

function toVersion(row: VersionRecord): VersionRow {
  return {
    id: row.id,
    priceListId: row.price_list_id,
    versionNo: row.version_no,
    status: row.status,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    approvalRequestId: row.approval_request_id,
    activatedAt: row.activated_at,
    activatedBy: row.activated_by,
    notes: row.notes,
    branchId: row.branch_id,
    entryCount: row.entry_count,
    version: row.version,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

/** MDM's price list tables in plain parameterised SQL over MDM's own schema (ADR-0030). */
export class PgPriceListStore implements PriceListStore {
  async tierExists(tx: Transaction, id: string): Promise<boolean> {
    return (await tx.query('SELECT 1 FROM mdm.customer_tier WHERE id = $1 AND deleted_at IS NULL', [id])).rows.length > 0;
  }

  async branchExists(tx: Transaction, id: string): Promise<boolean> {
    return (await tx.query('SELECT 1 FROM mdm.branch WHERE id = $1 AND deleted_at IS NULL', [id])).rows.length > 0;
  }

  async firstBranchId(tx: Transaction): Promise<string> {
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM mdm.branch WHERE deleted_at IS NULL AND status = 'ACTIVE' AND NOT is_test ORDER BY created_at, code LIMIT 1");
    if (rows[0] === undefined) {
      throw new Error('no active branch exists to register a price list version under');
    }
    return rows[0].id;
  }

  async insertList(tx: Transaction, id: string, list: NewPriceList, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO mdm.price_list (id, code, name, kind, channel, customer_tier_id, branch_id, tax_inclusive, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
      [id, list.code, list.name, list.kind, list.channel, list.customerTierId, list.branchId, list.taxInclusive, actorId],
    );
  }

  async list(tx: Transaction, id: string): Promise<PriceListRow | null> {
    const { rows } = await tx.query<ListRecord>(
      `SELECT l.id, l.code, l.name, l.kind, l.channel, t.id AS tier_id, t.code AS tier_code, t.name AS tier_name,
              b.id AS branch_id, b.code AS branch_code, b.name AS branch_name, l.tax_inclusive, l.version, l.created_at, l.updated_at
         FROM mdm.price_list l
         LEFT JOIN mdm.customer_tier t ON t.id = l.customer_tier_id
         LEFT JOIN mdm.branch b ON b.id = l.branch_id
        WHERE l.id = $1 AND l.deleted_at IS NULL`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      kind: row.kind,
      channel: row.channel,
      customerTier: row.tier_id === null ? null : { id: row.tier_id, code: row.tier_code!, name: row.tier_name! },
      branch: row.branch_id === null ? null : { id: row.branch_id, code: row.branch_code!, name: row.branch_name! },
      taxInclusive: row.tax_inclusive,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async versionsOfInterest(tx: Transaction, listId: string, now: Date): Promise<{ readonly active: VersionRow | null; readonly draftId: string | null }> {
    const active = await tx.query<VersionRecord>(
      `${VERSION_SELECT} WHERE v.price_list_id = $1 AND v.status = 'ACTIVE' AND v.valid_from <= $2 AND (v.valid_to IS NULL OR v.valid_to > $2)`,
      [listId, now],
    );
    const draft = await tx.query<{ id: string }>("SELECT id FROM mdm.price_list_version WHERE price_list_id = $1 AND status IN ('DRAFT', 'PENDING_APPROVAL')", [listId]);
    return { active: active.rows[0] === undefined ? null : toVersion(active.rows[0]), draftId: draft.rows[0]?.id ?? null };
  }

  async nextVersionNo(tx: Transaction, listId: string): Promise<number> {
    const { rows } = await tx.query<{ next: number }>('SELECT coalesce(max(version_no), 0)::int + 1 AS next FROM mdm.price_list_version WHERE price_list_id = $1', [listId]);
    return rows[0]!.next;
  }

  async insertVersion(
    tx: Transaction,
    version: { id: string; listId: string; versionNo: number; window: VersionWindow; notes: string | null; branchId: string },
    actorId: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO mdm.price_list_version (id, price_list_id, version_no, status, valid_from, valid_to, notes, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6, $7, $8, $8)`,
      [version.id, version.listId, version.versionNo, version.window.validFrom, version.window.validTo, version.notes, version.branchId, actorId],
    );
  }

  async version(tx: Transaction, id: string, lock: boolean): Promise<VersionRow | null> {
    const { rows } = await tx.query<VersionRecord>(`${VERSION_SELECT} WHERE v.id = $1${lock ? ' FOR UPDATE OF v' : ''}`, [id]);
    return rows[0] === undefined ? null : toVersion(rows[0]);
  }

  async entryReferences(tx: Transaction, inputs: readonly EntryInput[]): Promise<EntryReferences> {
    const ids = (pick: (input: EntryInput) => string | undefined) => [...new Set(inputs.flatMap((input) => (pick(input) === undefined ? [] : [pick(input)!])))];
    const [products, grades, bands] = await Promise.all([
      tx.query<{ id: string; species_id: string | null }>('SELECT id, species_id FROM mdm.product WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [ids((i) => i.productId)]),
      tx.query<{ id: string; species_id: string }>('SELECT id, species_id FROM mdm.grade WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [ids((i) => i.gradeId)]),
      tx.query<{ id: string; species_id: string }>('SELECT id, species_id FROM mdm.weight_band WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [ids((i) => i.weightBandId)]),
    ]);
    return {
      products: new Map(products.rows.map((row) => [row.id, { speciesId: row.species_id }])),
      grades: new Map(grades.rows.map((row) => [row.id, { speciesId: row.species_id }])),
      bands: new Map(bands.rows.map((row) => [row.id, { speciesId: row.species_id }])),
    };
  }

  async entries(tx: Transaction, versionId: string): Promise<readonly EntrySnapshot[]> {
    const { rows } = await tx.query<{
      id: string;
      product_id: string;
      grade_id: string | null;
      weight_band_id: string | null;
      basis: string;
      list_price: string;
      floor_price: string;
      ceiling_price: string;
      quote_only: boolean;
      min_qty: string;
    }>(
      `SELECT id, product_id, grade_id, weight_band_id, basis, list_price_pesewas::text AS list_price, floor_price_pesewas::text AS floor_price,
              ceiling_price_pesewas::text AS ceiling_price, quote_only, min_qty::text
         FROM mdm.price_list_entry WHERE version_id = $1 ORDER BY id`,
      [versionId],
    );
    return rows.map((row) => ({
      id: row.id,
      productId: row.product_id,
      gradeId: row.grade_id,
      weightBandId: row.weight_band_id,
      basis: row.basis,
      listPricePesewas: BigInt(row.list_price),
      floorPricePesewas: BigInt(row.floor_price),
      ceilingPricePesewas: BigInt(row.ceiling_price),
      quoteOnly: row.quote_only,
      minQty: row.min_qty,
    }));
  }

  async copyEntries(tx: Transaction, fromVersionId: string, toVersionId: string, actorId: string, newId: () => string): Promise<void> {
    const source = await this.entries(tx, fromVersionId);
    await this.insertEntries(
      tx,
      toVersionId,
      source.map((entry) => ({ ...entry, basis: entry.basis as EntryDefinition['basis'], minQty: entry.minQty })),
      actorId,
      newId,
    );
  }

  async replaceEntries(tx: Transaction, versionId: string, entries: readonly EntryDefinition[], actorId: string, newId: () => string): Promise<void> {
    await tx.query('SELECT mdm.clear_draft_price_list_entries($1)', [versionId]);
    await this.insertEntries(
      tx,
      versionId,
      entries.map((entry) => ({ ...entry, minQty: entry.minQty.toDecimalString() })),
      actorId,
      newId,
    );
  }

  async touchVersion(tx: Transaction, versionId: string, expectedVersion: number, actorId: string): Promise<boolean> {
    const result = await tx.query('UPDATE mdm.price_list_version SET version = version + 1, updated_by = $3 WHERE id = $1 AND version = $2', [versionId, expectedVersion, actorId]);
    return result.rowCount === 1;
  }

  async markPending(tx: Transaction, versionId: string, approvalRequestId: string, actorId: string): Promise<void> {
    await tx.query("UPDATE mdm.price_list_version SET status = 'PENDING_APPROVAL', approval_request_id = $2, version = version + 1, updated_by = $3 WHERE id = $1", [
      versionId,
      approvalRequestId,
      actorId,
    ]);
  }

  async activeWindows(tx: Transaction, listId: string): Promise<readonly ActiveWindow[]> {
    const { rows } = await tx.query<{ id: string; valid_from: Date; valid_to: Date | null }>(
      "SELECT id, valid_from, valid_to FROM mdm.price_list_version WHERE price_list_id = $1 AND status = 'ACTIVE' ORDER BY valid_from FOR UPDATE",
      [listId],
    );
    return rows.map((row) => ({ id: row.id, validFrom: row.valid_from, validTo: row.valid_to }));
  }

  async endVersion(tx: Transaction, versionId: string, validTo: Date, actorId: string): Promise<void> {
    await tx.query('UPDATE mdm.price_list_version SET valid_to = $2, version = version + 1, updated_by = $3 WHERE id = $1', [versionId, validTo, actorId]);
  }

  async supersede(tx: Transaction, versionId: string, actorId: string): Promise<void> {
    await tx.query("UPDATE mdm.price_list_version SET status = 'SUPERSEDED', version = version + 1, updated_by = $2 WHERE id = $1", [versionId, actorId]);
  }

  async activate(tx: Transaction, versionId: string, validFrom: Date, activatedBy: string, now: Date): Promise<void> {
    await tx.query(
      "UPDATE mdm.price_list_version SET status = 'ACTIVE', valid_from = $2, activated_at = $4, activated_by = $3, version = version + 1, updated_by = $3 WHERE id = $1",
      [versionId, validFrom, activatedBy, now],
    );
  }

  async reject(tx: Transaction, versionId: string, actorId: string): Promise<void> {
    await tx.query("UPDATE mdm.price_list_version SET status = 'REJECTED', version = version + 1, updated_by = $2 WHERE id = $1", [versionId, actorId]);
  }

  private async insertEntries(
    tx: Transaction,
    versionId: string,
    entries: ReadonlyArray<Omit<EntryDefinition, 'minQty'> & { readonly minQty: string }>,
    actorId: string,
    newId: () => string,
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    // One statement for the whole set, from parallel arrays: no SQL is built from values.
    await tx.query(
      `INSERT INTO mdm.price_list_entry (id, version_id, product_id, grade_id, weight_band_id, basis, list_price_pesewas, floor_price_pesewas,
                                         ceiling_price_pesewas, quote_only, min_qty, created_by, updated_by)
       SELECT u.id, $1, u.product_id, u.grade_id, u.weight_band_id, u.basis, u.list_price, u.floor_price, u.ceiling_price, u.quote_only, u.min_qty, $2, $2
         FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::uuid[], $7::text[], $8::bigint[], $9::bigint[], $10::bigint[], $11::boolean[], $12::numeric[])
              AS u (id, product_id, grade_id, weight_band_id, basis, list_price, floor_price, ceiling_price, quote_only, min_qty)`,
      [
        versionId,
        actorId,
        entries.map(() => newId()),
        entries.map((e) => e.productId),
        entries.map((e) => e.gradeId),
        entries.map((e) => e.weightBandId),
        entries.map((e) => e.basis),
        entries.map((e) => e.listPricePesewas.toString()),
        entries.map((e) => e.floorPricePesewas.toString()),
        entries.map((e) => e.ceilingPricePesewas.toString()),
        entries.map((e) => e.quoteOnly),
        entries.map((e) => e.minQty),
      ],
    );
  }
}
