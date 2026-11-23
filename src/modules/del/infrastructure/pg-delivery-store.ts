import type { Transaction } from '../../../platform/database/unit-of-work';
import type { AttemptRecord, ContentsLine, DeliveryFilter, DeliveryRecord, DeliveryStore, NewDelivery, ProofRecord, WriteOffFacts, WrittenOffFilter, WrittenOffRecord } from '../application/delivery-store';
import type { DeliveryStatus } from '../domain/deliveries';

interface DeliveryRow {
  id: string;
  delivery_no: string;
  order_document_id: string;
  billing_document_id: string;
  customer_id: string | null;
  slot_id: string | null;
  delivery_zone_id: string;
  recipient_name: string;
  recipient_phone_e164: string;
  address_snapshot: Record<string, unknown>;
  contents_summary: ContentsLine[];
  driver_id: string | null;
  vehicle_location_id: string | null;
  cod_due: string;
  cod_collected: string | null;
  attempt_count: number;
  dispatched_at: Date;
  delivered_at: Date | null;
  delivery_note_document_id: string | null;
  status: DeliveryStatus;
  branch_id: string;
  version: number;
}

interface ProofRow {
  id: string;
  delivery_id: string;
  recipient_name: string;
  signature_file_id: string | null;
  photo_file_id: string | null;
  latitude: string | null;
  longitude: string | null;
  position_accuracy_m: number | null;
  cod_collected: string;
  cod_variance_reason_code: string | null;
  cod_variance_note: string | null;
  payment_id: string | null;
  captured_at: Date;
  created_by: string;
}

const COLUMNS = `id, delivery_no, order_document_id, billing_document_id, customer_id, slot_id, delivery_zone_id, recipient_name, recipient_phone_e164,
  address_snapshot, contents_summary, driver_id, vehicle_location_id, cod_due_pesewas::text AS cod_due, cod_collected_pesewas::text AS cod_collected,
  attempt_count, dispatched_at, delivered_at, delivery_note_document_id, status, branch_id, version`;

const PROOF_COLUMNS = `id, delivery_id, recipient_name, signature_file_id, photo_file_id, latitude::text, longitude::text, position_accuracy_m,
  cod_collected_pesewas::text AS cod_collected, cod_variance_reason_code, cod_variance_note, payment_id, captured_at, created_by`;

function toRecord(r: DeliveryRow): DeliveryRecord {
  return {
    id: r.id,
    deliveryNo: r.delivery_no,
    orderDocumentId: r.order_document_id,
    billingDocumentId: r.billing_document_id,
    customerId: r.customer_id,
    slotId: r.slot_id,
    deliveryZoneId: r.delivery_zone_id,
    recipientName: r.recipient_name,
    recipientPhoneE164: r.recipient_phone_e164,
    addressSnapshot: r.address_snapshot,
    contents: r.contents_summary,
    driverId: r.driver_id,
    vehicleLocationId: r.vehicle_location_id,
    codDuePesewas: BigInt(r.cod_due),
    codCollectedPesewas: r.cod_collected === null ? null : BigInt(r.cod_collected),
    attemptCount: r.attempt_count,
    dispatchedAt: r.dispatched_at,
    deliveredAt: r.delivered_at,
    deliveryNoteDocumentId: r.delivery_note_document_id,
    status: r.status,
    branchId: r.branch_id,
    version: r.version,
  };
}

function toProof(r: ProofRow): ProofRecord {
  return {
    id: r.id,
    deliveryId: r.delivery_id,
    recipientName: r.recipient_name,
    signatureFileId: r.signature_file_id,
    photoFileId: r.photo_file_id,
    latitude: r.latitude,
    longitude: r.longitude,
    positionAccuracyM: r.position_accuracy_m,
    codCollectedPesewas: BigInt(r.cod_collected),
    codVarianceReasonCode: r.cod_variance_reason_code,
    codVarianceNote: r.cod_variance_note,
    paymentId: r.payment_id,
    capturedAt: r.captured_at,
    createdBy: r.created_by,
  };
}

/** Deliveries, attempts and proofs over DEL's own tables (migration 0303). */
export class PgDeliveryStore implements DeliveryStore {
  async insert(tx: Transaction, d: NewDelivery): Promise<void> {
    await tx.query(
      `INSERT INTO del.delivery (id, delivery_no, order_document_id, billing_document_id, customer_id, slot_id, delivery_zone_id, recipient_name, recipient_phone_e164,
                                 address_snapshot, contents_summary, driver_id, vehicle_location_id, cod_due_pesewas, dispatched_at, status, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $18)`,
      [
        d.id,
        d.deliveryNo,
        d.orderDocumentId,
        d.billingDocumentId,
        d.customerId,
        d.slotId,
        d.deliveryZoneId,
        d.recipientName,
        d.recipientPhoneE164,
        JSON.stringify(d.addressSnapshot),
        JSON.stringify(d.contents),
        d.driverId,
        d.vehicleLocationId,
        d.codDuePesewas.toString(),
        d.dispatchedAt,
        d.status,
        d.branchId,
        d.actorId,
      ],
    );
  }

  async deliveries(tx: Transaction, ids: readonly string[]): Promise<DeliveryRecord[]> {
    if (ids.length === 0) return [];
    const rows = (await tx.query<DeliveryRow>(`SELECT ${COLUMNS} FROM del.delivery WHERE id = ANY($1::uuid[])`, [[...ids]])).rows.map(toRecord);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  }

  async lock(tx: Transaction, id: string): Promise<DeliveryRecord | null> {
    const row = (await tx.query<DeliveryRow>(`SELECT ${COLUMNS} FROM del.delivery WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async liveOfOrder(tx: Transaction, orderDocumentId: string): Promise<DeliveryRecord | null> {
    const row = (await tx.query<DeliveryRow>(`SELECT ${COLUMNS} FROM del.delivery WHERE order_document_id = $1 AND status <> 'CANCELLED'`, [orderDocumentId])).rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async list(tx: Transaction, f: DeliveryFilter, beforeId: string | null, limit: number): Promise<string[]> {
    if (f.branchIds.length === 0) return [];
    const rows = await tx.query<{ id: string }>(
      `SELECT id FROM del.delivery
        WHERE branch_id = ANY($1::uuid[]) AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR driver_id = $3)
          AND ($4::uuid IS NULL OR order_document_id = $4) AND ($5::uuid IS NULL OR id < $5)
          AND ($7::uuid IS NULL OR delivery_zone_id = $7)
          AND ($8::date IS NULL OR (dispatched_at >= $8::date::timestamp AT TIME ZONE 'UTC' AND dispatched_at < ($8::date + 1)::timestamp AT TIME ZONE 'UTC'))
        ORDER BY id DESC LIMIT $6`,
      [[...f.branchIds], f.status, f.driverId, f.orderId, beforeId, limit, f.zoneId, f.date],
    );
    return rows.rows.map((r) => r.id);
  }

  async proofsOf(tx: Transaction, deliveryIds: readonly string[]): Promise<ProofRecord[]> {
    if (deliveryIds.length === 0) return [];
    return (await tx.query<ProofRow>(`SELECT ${PROOF_COLUMNS} FROM del.proof_of_delivery WHERE delivery_id = ANY($1::uuid[])`, [[...deliveryIds]])).rows.map(toProof);
  }

  async proofById(tx: Transaction, id: string): Promise<ProofRecord | null> {
    const row = (await tx.query<ProofRow>(`SELECT ${PROOF_COLUMNS} FROM del.proof_of_delivery WHERE id = $1`, [id])).rows[0];
    return row === undefined ? null : toProof(row);
  }

  async insertAttempt(tx: Transaction, a: AttemptRecord): Promise<void> {
    await tx.query(
      `INSERT INTO del.delivery_attempt (id, delivery_id, attempt_no, outcome, failure_reason_code, next_action, latitude, longitude, occurred_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9, $10)`,
      [a.id, a.deliveryId, a.attemptNo, a.outcome, a.failureReasonCode, a.nextAction, a.latitude, a.longitude, a.occurredAt, a.actorId],
    );
  }

  async insertProof(tx: Transaction, p: ProofRecord): Promise<void> {
    await tx.query(
      `INSERT INTO del.proof_of_delivery (id, delivery_id, recipient_name, signature_file_id, photo_file_id, latitude, longitude, position_accuracy_m,
                                          cod_collected_pesewas, cod_variance_reason_code, cod_variance_note, payment_id, captured_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8, $9, $10, $11, $12, $13, $14)`,
      [
        p.id,
        p.deliveryId,
        p.recipientName,
        p.signatureFileId,
        p.photoFileId,
        p.latitude,
        p.longitude,
        p.positionAccuracyM,
        p.codCollectedPesewas.toString(),
        p.codVarianceReasonCode,
        p.codVarianceNote,
        p.paymentId,
        p.capturedAt,
        p.createdBy,
      ],
    );
  }

  async markDelivered(tx: Transaction, id: string, d: { readonly collectedPesewas: bigint; readonly at: Date; readonly actorId: string }): Promise<void> {
    await tx.query(
      `UPDATE del.delivery SET status = 'DELIVERED', cod_collected_pesewas = $2, delivered_at = $3, attempt_count = attempt_count + 1,
              posted_at = $3, posted_by = $4, updated_at = $3, updated_by = $4, version = version + 1
        WHERE id = $1`,
      [id, d.collectedPesewas.toString(), d.at, d.actorId],
    );
  }

  async markOnTheWay(tx: Transaction, id: string, d: { readonly at: Date; readonly actorId: string }): Promise<void> {
    await tx.query(`UPDATE del.delivery SET status = 'OUT_FOR_DELIVERY', on_the_way_at = $2, updated_by = $3, version = version + 1 WHERE id = $1`, [id, d.at, d.actorId]);
  }

  async markFailed(tx: Transaction, id: string, d: { readonly at: Date; readonly actorId: string }): Promise<void> {
    await tx.query(`UPDATE del.delivery SET status = 'FAILED', attempt_count = attempt_count + 1, updated_at = $2, updated_by = $3, version = version + 1 WHERE id = $1`, [id, d.at, d.actorId]);
  }

  async markReturned(tx: Transaction, id: string, d: { readonly at: Date; readonly actorId: string }): Promise<void> {
    await tx.query(`UPDATE del.delivery SET status = 'RETURNED', posted_at = $2, posted_by = $3, updated_at = $2, updated_by = $3, version = version + 1 WHERE id = $1`, [id, d.at, d.actorId]);
  }

  async markWrittenOff(tx: Transaction, id: string, d: WriteOffFacts & { readonly at: Date; readonly actorId: string }): Promise<void> {
    await tx.query(
      `UPDATE del.delivery SET status = 'WRITTEN_OFF', written_off_reason_code = $2, written_off_value_pesewas = $3, write_off_document_id = $4, written_off_at = $5,
              posted_at = $5, posted_by = $6, updated_at = $5, updated_by = $6, version = version + 1
        WHERE id = $1`,
      [id, d.reasonCode, d.valuePesewas.toString(), d.stockAdjustmentId, d.at, d.actorId],
    );
  }

  async writtenOff(tx: Transaction, f: WrittenOffFilter, beforeId: string | null, limit: number): Promise<WrittenOffRecord[]> {
    const { rows } = await tx.query<{
      id: string;
      delivery_no: string;
      order_document_id: string;
      driver_id: string | null;
      vehicle_location_id: string | null;
      route_id: string | null;
      reason: string;
      value: string;
      adjustment: string;
      at: Date;
      branch_id: string;
    }>(
      `SELECT d.id, d.delivery_no, d.order_document_id, d.driver_id, d.vehicle_location_id, s.route_id, d.written_off_reason_code AS reason,
              d.written_off_value_pesewas::text AS value, d.write_off_document_id AS adjustment, d.written_off_at AS at, d.branch_id
         FROM del.delivery d LEFT JOIN del.route_stop s ON s.delivery_id = d.id
        WHERE d.status = 'WRITTEN_OFF' AND d.branch_id = ANY($1::uuid[]) AND d.written_off_reason_code = ANY($2::text[])
          AND ($3::uuid IS NULL OR d.driver_id = $3)
          AND ($4::date IS NULL OR d.written_off_at >= $4::date::timestamp AT TIME ZONE 'UTC')
          AND ($5::date IS NULL OR d.written_off_at < ($5::date + 1)::timestamp AT TIME ZONE 'UTC')
          AND ($6::uuid IS NULL OR d.id < $6)
        ORDER BY d.id DESC LIMIT $7`,
      [f.branchIds, f.reasonCodes, f.driverId, f.from, f.to, beforeId, limit],
    );
    return rows.map((r) => ({
      deliveryId: r.id,
      deliveryNo: r.delivery_no,
      orderDocumentId: r.order_document_id,
      driverId: r.driver_id,
      vehicleLocationId: r.vehicle_location_id,
      routeId: r.route_id,
      reasonCode: r.reason,
      valuePesewas: BigInt(r.value),
      stockAdjustmentId: r.adjustment,
      writtenOffAt: r.at,
      branchId: r.branch_id,
    }));
  }

  async attemptById(tx: Transaction, id: string): Promise<AttemptRecord | null> {
    const row = (
      await tx.query<{ id: string; delivery_id: string; attempt_no: number; outcome: 'DELIVERED' | 'FAILED'; failure_reason_code: string | null; next_action: 'REATTEMPT' | 'RETURN_TO_STOCK' | null; latitude: string | null; longitude: string | null; occurred_at: Date; created_by: string }>(
        `SELECT id, delivery_id, attempt_no, outcome, failure_reason_code, next_action, latitude::text, longitude::text, occurred_at, created_by FROM del.delivery_attempt WHERE id = $1`,
        [id],
      )
    ).rows[0];
    return row === undefined
      ? null
      : { id: row.id, deliveryId: row.delivery_id, attemptNo: row.attempt_no, outcome: row.outcome, failureReasonCode: row.failure_reason_code, nextAction: row.next_action, latitude: row.latitude, longitude: row.longitude, occurredAt: row.occurred_at, actorId: row.created_by };
  }

  async reassign(tx: Transaction, id: string, d: { readonly driverId: string; readonly vehicleLocationId: string; readonly at: Date; readonly actorId: string }): Promise<void> {
    await tx.query(`UPDATE del.delivery SET driver_id = $2, vehicle_location_id = $3, updated_at = $4, updated_by = $5, version = version + 1 WHERE id = $1`, [id, d.driverId, d.vehicleLocationId, d.at, d.actorId]);
  }

  async book(tx: Transaction, id: string, d: { readonly slotId: string; readonly reattempt: boolean; readonly at: Date; readonly actorId: string }): Promise<void> {
    await tx.query(
      `UPDATE del.delivery SET slot_id = $2, status = CASE WHEN $3 THEN 'ASSIGNED' ELSE status END, updated_at = $4, updated_by = $5, version = version + 1 WHERE id = $1`,
      [id, d.slotId, d.reattempt, d.at, d.actorId],
    );
  }

  async routeOf(tx: Transaction, deliveryId: string): Promise<{ readonly id: string; readonly status: 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED'; readonly routeDate: string } | null> {
    const row = (
      await tx.query<{ id: string; status: 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED'; route_date: string }>(
        `SELECT r.id, r.status, to_char(r.route_date, 'YYYY-MM-DD') AS route_date FROM del.route_stop s JOIN del.route r ON r.id = s.route_id WHERE s.delivery_id = $1`,
        [deliveryId],
      )
    ).rows[0];
    return row === undefined ? null : { id: row.id, status: row.status, routeDate: row.route_date };
  }

  async routeStatusOf(tx: Transaction, deliveryId: string): Promise<'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' | null> {
    const row = (await tx.query<{ status: 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' }>(`SELECT r.status FROM del.route_stop s JOIN del.route r ON r.id = s.route_id WHERE s.delivery_id = $1`, [deliveryId])).rows[0];
    return row?.status ?? null;
  }
}
