import type { Transaction } from '../../../platform/database/unit-of-work';
import type { AssignmentWindow } from '../domain/parties';
import type { RowState } from '../application/admin-kit';
import type { ZoneForMatch } from '../domain/reference-data';
import { deliverableZones } from './pg-reference-data-store';
import type { AddressView, AddressWrite, AssignmentRecord, CustomerFilters, CustomerKind, CustomerStatus, CustomerRecord, CustomerWrite, PartiesStore, PriceListFacts, TierView } from '../application/parties-store';

const CUSTOMER_UPDATABLE: ReadonlySet<string> = new Set(['name', 'phone_e164', 'phone_hash', 'email', 'tier_id', 'tin_enc', 'status']);
const ADDRESS_UPDATABLE: ReadonlySet<string> = new Set([
  'label',
  'recipient_name',
  'recipient_phone_e164',
  'line1',
  'area',
  'city',
  'region',
  'digital_address',
  'directions',
  'latitude',
  'longitude',
  'is_default',
  'delivery_zone_id',
]);

/** `$1` is the instant the assigned list is read at. */
const CUSTOMER_SELECT = `
  SELECT c.id, c.public_id, c.kind, c.name, c.phone_e164, c.email, c.principal_id IS NOT NULL AS has_login, c.tin_enc,
         c.marketing_consent_at, c.status, c.deleted_at IS NOT NULL AS archived, c.version, c.created_at, c.updated_at,
         t.id AS tier_id, t.code AS tier_code, t.name AS tier_name,
         l.id AS list_id, l.code AS list_code, l.name AS list_name,
         (SELECT a.area FROM mdm.customer_address a WHERE a.customer_id = c.id AND a.is_default AND a.deleted_at IS NULL) AS default_area
    FROM mdm.customer c
    JOIN mdm.customer_tier t ON t.id = c.tier_id
    LEFT JOIN mdm.customer_price_list cpl ON cpl.customer_id = c.id AND cpl.deleted_at IS NULL AND cpl.valid_from <= $1 AND (cpl.valid_to IS NULL OR cpl.valid_to > $1)
    LEFT JOIN mdm.price_list l ON l.id = cpl.price_list_id`;

const ADDRESS_SELECT = `
  SELECT a.id, a.customer_id, a.label, a.recipient_name, a.recipient_phone_e164, a.line1, a.area, a.city, a.region, a.digital_address, a.directions,
         a.latitude::text AS latitude, a.longitude::text AS longitude, a.is_default, a.version, z.id AS zone_id, z.code AS zone_code, z.name AS zone_name
    FROM mdm.customer_address a
    LEFT JOIN mdm.delivery_zone z ON z.id = a.delivery_zone_id`;

interface CustomerRow {
  id: string;
  public_id: string;
  kind: CustomerRecord['kind'];
  name: string;
  phone_e164: string | null;
  email: string | null;
  has_login: boolean;
  tin_enc: Buffer | null;
  marketing_consent_at: Date | null;
  status: CustomerRecord['status'];
  archived: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
  tier_id: string;
  tier_code: string;
  tier_name: string;
  list_id: string | null;
  list_code: string | null;
  list_name: string | null;
  default_area: string | null;
}

function toCustomer(row: CustomerRow): CustomerRecord {
  return {
    id: row.id,
    publicId: row.public_id,
    kind: row.kind,
    name: row.name,
    phone: row.phone_e164,
    email: row.email,
    tier: { id: row.tier_id, code: row.tier_code, name: row.tier_name },
    hasLogin: row.has_login,
    tinEnc: row.tin_enc,
    marketingConsentAt: row.marketing_consent_at?.toISOString() ?? null,
    status: row.status,
    priceList: row.list_id === null ? null : { id: row.list_id, code: row.list_code!, name: row.list_name! },
    defaultArea: row.default_area,
    archived: row.archived,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

interface AddressRow {
  id: string;
  customer_id: string;
  label: string;
  recipient_name: string;
  recipient_phone_e164: string;
  line1: string;
  area: string;
  city: string;
  region: string;
  digital_address: string | null;
  directions: string | null;
  latitude: string | null;
  longitude: string | null;
  is_default: boolean;
  version: number;
  zone_id: string | null;
  zone_code: string | null;
  zone_name: string | null;
}

function toAddress(row: AddressRow): AddressView {
  return {
    id: row.id,
    customerId: row.customer_id,
    label: row.label,
    recipientName: row.recipient_name,
    recipientPhone: row.recipient_phone_e164,
    line1: row.line1,
    area: row.area,
    city: row.city,
    region: row.region,
    digitalAddress: row.digital_address,
    directions: row.directions,
    latitude: row.latitude,
    longitude: row.longitude,
    deliveryZone: row.zone_id === null ? null : { id: row.zone_id, code: row.zone_code!, name: row.zone_name! },
    isDefault: row.is_default,
    version: row.version,
  };
}

async function updateRow(tx: Transaction, table: string, allowed: ReadonlySet<string>, id: string, expectedVersion: number, columns: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean> {
  const names = Object.keys(columns);
  for (const name of names) {
    if (!allowed.has(name)) {
      throw new Error(`${table}.${name} is not an updatable column`);
    }
  }
  const sets = names.map((name, index) => `${name} = $${index + 4}`);
  const result = await tx.query(
    `UPDATE ${table} SET ${[...sets, 'version = version + 1', 'updated_at = now()', 'updated_by = $3'].join(', ')} WHERE id = $1 AND version = $2 AND deleted_at IS NULL`,
    [id, expectedVersion, actorId, ...names.map((name) => columns[name])],
  );
  return result.rowCount === 1;
}

async function archiveRow(tx: Transaction, table: string, id: string, expectedVersion: number, reason: string, actorId: string, now: Date): Promise<boolean> {
  const result = await tx.query(
    `UPDATE ${table} SET deleted_at = $4, deleted_by = $3, delete_reason = $5, version = version + 1, updated_at = $4, updated_by = $3
      WHERE id = $1 AND version = $2 AND deleted_at IS NULL`,
    [id, expectedVersion, actorId, now, reason],
  );
  return result.rowCount === 1;
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** MDM's party tables in plain SQL; reads join only MDM's own tables. */
export class PgPartiesStore implements PartiesStore {
  async tiers(tx: Transaction, afterId: string | null, limit: number): Promise<TierView[]> {
    const { rows } = await tx.query<TierView>('SELECT id, code, name FROM mdm.customer_tier WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR id > $1) ORDER BY id LIMIT $2', [afterId, limit]);
    return rows;
  }

  async tier(tx: Transaction, id: string): Promise<TierView | null> {
    const { rows } = await tx.query<TierView>('SELECT id, code, name FROM mdm.customer_tier WHERE id = $1 AND deleted_at IS NULL', [id]);
    return rows[0] ?? null;
  }

  async tierByCode(tx: Transaction, code: string): Promise<TierView | null> {
    const { rows } = await tx.query<TierView>('SELECT id, code, name FROM mdm.customer_tier WHERE code = $1 AND deleted_at IS NULL', [code]);
    return rows[0] ?? null;
  }

  async insertTier(tx: Transaction, id: string, w: { readonly code: string; readonly name: string }, actorId: string): Promise<void> {
    await tx.query('INSERT INTO mdm.customer_tier (id, code, name, created_by, updated_by) VALUES ($1, $2, $3, $4, $4)', [id, w.code, w.name, actorId]);
  }

  async nextCustomerNo(tx: Transaction): Promise<string> {
    const { rows } = await tx.query<{ no: string }>("SELECT 'C-' || lpad(nextval('mdm.customer_no_seq')::text, 5, '0') AS no");
    return rows[0]!.no;
  }

  async lockCustomer(tx: Transaction, id: string): Promise<RowState | null> {
    const { rows } = await tx.query<RowState>('SELECT version, deleted_at IS NOT NULL AS archived FROM mdm.customer WHERE id = $1 FOR UPDATE', [id]);
    return rows[0] ?? null;
  }

  async customer(tx: Transaction, id: string, at: Date): Promise<CustomerRecord | null> {
    const { rows } = await tx.query<CustomerRow>(`${CUSTOMER_SELECT} WHERE c.id = $2`, [at, id]);
    return rows[0] === undefined ? null : toCustomer(rows[0]);
  }

  async customers(tx: Transaction, f: CustomerFilters, at: Date, afterId: string | null, limit: number): Promise<CustomerRecord[]> {
    const { rows } = await tx.query<CustomerRow>(
      `${CUSTOMER_SELECT}
        WHERE c.deleted_at IS NULL
          AND ($2::text IS NULL OR c.name ILIKE '%' || $2 || '%') AND ($3::bytea IS NULL OR c.phone_hash = $3)
          AND ($4::text IS NULL OR c.kind = $4) AND ($5::uuid IS NULL OR c.tier_id = $5) AND ($6::text IS NULL OR c.status = $6)
          AND ($7::uuid IS NULL OR c.id > $7) AND ($9::text IS NULL OR c.public_id = $9)
        ORDER BY c.id LIMIT $8`,
      [at, f.name === undefined ? null : escapeLike(f.name), f.phoneHash ?? null, f.kind ?? null, f.tierId ?? null, f.status ?? null, afterId, limit, f.publicId ?? null],
    );
    return rows.map(toCustomer);
  }

  async phoneTaken(tx: Transaction, phoneHash: Buffer, exceptId: string | null): Promise<boolean> {
    const { rows } = await tx.query('SELECT 1 FROM mdm.customer WHERE phone_hash = $1 AND deleted_at IS NULL AND id IS DISTINCT FROM $2', [phoneHash, exceptId]);
    return rows.length > 0;
  }

  async customerByPhoneHash(tx: Transaction, phoneHash: Buffer): Promise<{ id: string; publicId: string } | null> {
    const { rows } = await tx.query<{ id: string; public_id: string }>('SELECT id, public_id FROM mdm.customer WHERE phone_hash = $1 AND deleted_at IS NULL', [phoneHash]);
    return rows.length === 0 ? null : { id: rows[0]!.id, publicId: rows[0]!.public_id };
  }

  async customerByPublicId(tx: Transaction, publicId: string): Promise<{ id: string; kind: CustomerKind; status: CustomerStatus; version: number } | null> {
    const { rows } = await tx.query<{ id: string; kind: CustomerKind; status: CustomerStatus; version: number }>(
      'SELECT id, kind, status, version FROM mdm.customer WHERE public_id = $1 AND deleted_at IS NULL',
      [publicId],
    );
    return rows[0] ?? null;
  }

  async insertCustomer(tx: Transaction, id: string, w: CustomerWrite, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO mdm.customer (id, customer_no, public_id, kind, name, phone_e164, phone_hash, email, tier_id, tin_enc, marketing_consent_at, status, created_by, updated_by)
       VALUES ($1, $2, $12, $3, $4, $5, $6, $7, $8, $9, $10, 'ACTIVE', $11, $11)`,
      [id, w.customerNo, w.kind, w.name, w.phone, w.phoneHash, w.email, w.tierId, w.tinEnc, w.marketingConsentAt, actorId, w.publicId],
    );
  }

  updateCustomer(tx: Transaction, id: string, expectedVersion: number, columns: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean> {
    return updateRow(tx, 'mdm.customer', CUSTOMER_UPDATABLE, id, expectedVersion, columns, actorId);
  }

  archiveCustomer(tx: Transaction, id: string, expectedVersion: number, reason: string, actorId: string, now: Date): Promise<boolean> {
    return archiveRow(tx, 'mdm.customer', id, expectedVersion, reason, actorId, now);
  }

  async lockAddress(tx: Transaction, id: string): Promise<RowState | null> {
    const { rows } = await tx.query<RowState>('SELECT version, deleted_at IS NOT NULL AS archived FROM mdm.customer_address WHERE id = $1 FOR UPDATE', [id]);
    return rows[0] ?? null;
  }

  async address(tx: Transaction, id: string): Promise<AddressView | null> {
    const { rows } = await tx.query<AddressRow>(`${ADDRESS_SELECT} WHERE a.id = $1`, [id]);
    return rows[0] === undefined ? null : toAddress(rows[0]);
  }

  async addresses(tx: Transaction, customerId: string, afterId: string | null, limit: number): Promise<AddressView[]> {
    const { rows } = await tx.query<AddressRow>(`${ADDRESS_SELECT} WHERE a.customer_id = $1 AND a.deleted_at IS NULL AND ($2::uuid IS NULL OR a.id > $2) ORDER BY a.id LIMIT $3`, [customerId, afterId, limit]);
    return rows.map(toAddress);
  }

  async insertAddress(tx: Transaction, id: string, w: AddressWrite, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO mdm.customer_address (id, customer_id, label, recipient_name, recipient_phone_e164, line1, area, city, region, digital_address, directions, latitude, longitude, is_default, delivery_zone_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)`,
      [id, w.customerId, w.label, w.recipientName, w.recipientPhone, w.line1, w.area, w.city, w.region, w.digitalAddress, w.directions, w.latitude, w.longitude, w.isDefault, w.deliveryZoneId, actorId],
    );
  }

  updateAddress(tx: Transaction, id: string, expectedVersion: number, columns: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean> {
    return updateRow(tx, 'mdm.customer_address', ADDRESS_UPDATABLE, id, expectedVersion, columns, actorId);
  }

  archiveAddress(tx: Transaction, id: string, expectedVersion: number, reason: string, actorId: string, now: Date): Promise<boolean> {
    return archiveRow(tx, 'mdm.customer_address', id, expectedVersion, reason, actorId, now);
  }

  async clearDefaultAddress(tx: Transaction, customerId: string, exceptId: string | null, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE mdm.customer_address SET is_default = false, version = version + 1, updated_at = now(), updated_by = $3
        WHERE customer_id = $1 AND is_default AND deleted_at IS NULL AND id IS DISTINCT FROM $2`,
      [customerId, exceptId, actorId],
    );
  }

  async livePriceList(tx: Transaction, id: string): Promise<PriceListFacts | null> {
    const { rows } = await tx.query<PriceListFacts>('SELECT id, code, name, kind FROM mdm.price_list WHERE id = $1 AND deleted_at IS NULL', [id]);
    return rows[0] ?? null;
  }

  async liveAssignments(tx: Transaction, customerId: string): Promise<AssignmentWindow[]> {
    const { rows } = await tx.query<{ id: string; valid_from: Date; valid_to: Date | null }>(
      'SELECT id, valid_from, valid_to FROM mdm.customer_price_list WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY valid_from FOR UPDATE',
      [customerId],
    );
    return rows.map((row) => ({ id: row.id, validFrom: row.valid_from, validTo: row.valid_to }));
  }

  async customerAssignments(tx: Transaction, customerId: string, at: Date): Promise<AssignmentRecord[] | null> {
    const live = await tx.query('SELECT 1 FROM mdm.customer WHERE id = $1 AND deleted_at IS NULL', [customerId]);
    if (live.rows.length === 0) return null;
    return this.assignments(tx, 'a.customer_id = $1', [customerId, at], 'a.valid_from, a.id');
  }

  async priceListHolders(tx: Transaction, priceListId: string, at: Date, afterId: string | null, limit: number): Promise<AssignmentRecord[]> {
    return this.assignments(tx, 'a.price_list_id = $1 AND ($3::uuid IS NULL OR a.id > $3)', [priceListId, at, afterId, limit], 'a.id', 'LIMIT $4');
  }

  async priceListExists(tx: Transaction, priceListId: string): Promise<boolean> {
    return (await tx.query('SELECT 1 FROM mdm.price_list WHERE id = $1 AND deleted_at IS NULL', [priceListId])).rows.length > 0;
  }

  private async assignments(tx: Transaction, where: string, values: unknown[], order: string, limit = ''): Promise<AssignmentRecord[]> {
    const { rows } = await tx.query<{ id: string; customer_id: string; public_id: string; customer_name: string; list_id: string; code: string; list_name: string; valid_from: Date; valid_to: Date | null }>(
      `SELECT a.id, c.id AS customer_id, c.public_id, c.name AS customer_name, l.id AS list_id, l.code, l.name AS list_name, a.valid_from, a.valid_to
         FROM mdm.customer_price_list a JOIN mdm.customer c ON c.id = a.customer_id JOIN mdm.price_list l ON l.id = a.price_list_id
        WHERE ${where} AND a.deleted_at IS NULL AND c.deleted_at IS NULL AND (a.valid_to IS NULL OR a.valid_to > $2)
        ORDER BY ${order} ${limit}`,
      values,
    );
    return rows.map((r) => ({ id: r.id, customer: { id: r.customer_id, publicId: r.public_id, name: r.customer_name }, priceList: { id: r.list_id, code: r.code, name: r.list_name }, validFrom: r.valid_from, validTo: r.valid_to }));
  }

  async endAssignment(tx: Transaction, id: string, validTo: Date, actorId: string): Promise<void> {
    await tx.query('UPDATE mdm.customer_price_list SET valid_to = $2, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = $1', [id, validTo, actorId]);
  }

  async archiveAssignment(tx: Transaction, id: string, reason: string, actorId: string, now: Date): Promise<void> {
    await tx.query(
      'UPDATE mdm.customer_price_list SET deleted_at = $4, deleted_by = $3, delete_reason = $2, version = version + 1, updated_at = $4, updated_by = $3 WHERE id = $1',
      [id, reason, actorId, now],
    );
  }

  async insertAssignment(
    tx: Transaction,
    id: string,
    w: { readonly customerId: string; readonly priceListId: string; readonly validFrom: Date; readonly validTo: Date | null },
    actorId: string,
  ): Promise<void> {
    await tx.query(
      'INSERT INTO mdm.customer_price_list (id, customer_id, price_list_id, valid_from, valid_to, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)',
      [id, w.customerId, w.priceListId, w.validFrom, w.validTo, actorId],
    );
  }

  deliverableZones(tx: Transaction): Promise<ZoneForMatch[]> {
    return deliverableZones(tx);
  }
}
