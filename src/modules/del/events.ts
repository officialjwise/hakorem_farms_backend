/**
 * Events DEL publishes (docs/DOMAIN_MODEL.md section 5). Types only: subscribers import them with `import type`. Amounts
 * are JSON integers of pesewas.
 */

/**
 * `del.DeliveryCompleted` v1: a delivery's proof was recorded and the delivery is DELIVERED. ORD subscribes in the
 * transaction (ADR-0010): the goods are issued from the vehicle to the customer and the order moves to DELIVERED. The
 * cash collected short of the amount due, with its reason, is what the daily exception report reads (abuse case 43).
 */
export interface DeliveryCompleted {
  readonly deliveryId: string;
  readonly deliveryNo: string;
  readonly orderDocumentId: string;
  readonly billingDocumentId: string;
  readonly branchId: string;
  readonly driverId: string;
  readonly vehicleLocationId: string;
  readonly proofId: string;
  readonly codDuePesewas: number;
  readonly codCollectedPesewas: number;
  readonly codShortPesewas: number;
  readonly codVarianceReasonCode: string | null;
  readonly deliveredAt: string;
}

/**
 * ◆ `del.CodCollected` v1 (ADR-0003): cash collected on delivery, held by the driver. FIN posts Dr 1020 against the
 * driver, Cr 1200 against the customer (migration 0305). PAY recorded the payment and allocated it in the same
 * transaction.
 */
export interface CodCollected {
  readonly proofId: string;
  readonly deliveryId: string;
  readonly paymentId: string;
  readonly driverId: string;
  readonly driverName: string;
  readonly customerId: string | null;
  readonly branchId: string;
  readonly collectedPesewas: number;
}

/**
 * ◆ `del.DriverCashRemitted` v1 (ADR-0003, ADR-0092, CR-057): a driver's cash on delivery counted into a till shift by
 * its own cashier, every collection the driver held at the branch handed in once. FIN posts Dr 1000 against the till for
 * what was received, Cr 1020 against the driver for what was expected, the short as a debit and the over as a credit on
 * 6900 (migration 0315). Not EXACT, it is the driver variance report's line (`DRIVER_VARIANCE`, abuse cases 6 and 43, B12).
 */
export interface DriverCashRemitted {
  readonly reconciliationId: string;
  readonly driverId: string;
  readonly driverName: string;
  readonly receivedBy: string;
  readonly shiftId: string;
  readonly register: { readonly id: string; readonly code: string };
  readonly tillPaymentId: string | null;
  readonly branchId: string;
  readonly expectedPesewas: number;
  readonly receivedPesewas: number;
  readonly shortPesewas: number;
  readonly overPesewas: number;
  readonly varianceDirection: 'OVER' | 'SHORT' | 'EXACT';
  readonly proofIds: readonly string[];
  readonly abuseCases: readonly number[];
  readonly handedInAt: string;
}

/**
 * `del.DeliveryOnTheWay` v1 (FR-DEL-007, FR-DEL-012): the driver set off for this stop. NTF tells the customer once
 * (B11 continued 4), reading the recipient's phone from the delivery by its id when it sends: no phone or name is
 * written to the outbox (SECURE_CODING_STANDARDS, logging and personal data).
 */
export interface DeliveryOnTheWay {
  readonly deliveryId: string;
  readonly deliveryNo: string;
  readonly orderDocumentId: string;
  readonly branchId: string;
  readonly driverId: string;
  readonly etaMinutes: number | null;
  readonly occurredAt: string;
}

/**
 * `del.DeliveryFailed` v1 (FR-DEL-011): an attempt failed, with its reason and what the driver asks next. ORD subscribes
 * in the transaction (ADR-0010) and moves the order DISPATCHED to DELIVERY_FAILED; the goods stay on the van, the farm's,
 * until a reattempt or a return to stock (B11 continued 4).
 */
export interface DeliveryFailed {
  readonly deliveryId: string;
  readonly deliveryNo: string;
  readonly orderDocumentId: string;
  readonly branchId: string;
  readonly driverId: string;
  readonly attemptNo: number;
  readonly failureReasonCode: string;
  readonly nextAction: 'REATTEMPT' | 'RETURN_TO_STOCK';
  readonly occurredAt: string;
}

/**
 * `del.RouteCompleted` v1 (FR-DEL-005, the owner's close rule, 2026-11-23): a driver's run closed with nothing left on
 * the van and nothing held; the hand-ins that took its cash are named (A-345 (g)).
 */
export interface RouteCompleted {
  readonly routeId: string;
  readonly driverId: string;
  readonly routeDate: string;
  readonly branchId: string;
  readonly deliveryIds: readonly string[];
  readonly codCollectedPesewas: number;
  readonly reconciliationIds: readonly string[];
  readonly completedAt: string;
}

/**
 * `del.DeliveryReturned` v1 (FR-DEL-011, B11 continued 4): a failed delivery's goods came off the van into the branch
 * returns hold, not sellable until inspected; ORD moved the stock, credited the document and moved the order RETURNED in
 * the same transaction.
 */
export interface DeliveryReturned {
  readonly deliveryId: string;
  readonly deliveryNo: string;
  readonly orderDocumentId: string;
  readonly branchId: string;
  readonly driverId: string | null;
  readonly vehicleLocationId: string | null;
  readonly returnsLocationId: string;
  readonly returnedAt: string;
}

/**
 * `del.DeliveryWrittenOff` v1 (FR-DEL-011, the owner's van rule of 2026-11-23): a failed delivery's goods were written off
 * the van through INV's adjustment, with its reason and its value at cost. `unaccounted` names the driver variance (goods
 * the driver cannot account for, abuse case 48), which the daily exception report reads.
 */
export interface DeliveryWrittenOff {
  readonly deliveryId: string;
  readonly deliveryNo: string;
  readonly orderDocumentId: string;
  readonly branchId: string;
  readonly driverId: string | null;
  readonly vehicleLocationId: string | null;
  readonly reasonCode: string;
  readonly valuePesewas: number;
  readonly stockAdjustmentId: string;
  readonly unaccounted: boolean;
  readonly writtenOffAt: string;
  readonly abuseCases: readonly number[];
}

/**
 * `del.DeliveryReassigned` v1 (FR-DEL-004, B11 continued 5): a delivery waiting on the van or failed, on no live run, was
 * given another driver or vehicle. When the vehicle changed, ORD moved its goods from the one van to the other in the
 * same transaction (still the farm's stock, never below zero).
 */
export interface DeliveryReassigned {
  readonly deliveryId: string;
  readonly deliveryNo: string;
  readonly orderDocumentId: string;
  readonly branchId: string;
  readonly fromDriverId: string | null;
  readonly toDriverId: string;
  readonly fromVehicleLocationId: string | null;
  readonly toVehicleLocationId: string;
  readonly reassignedAt: string;
}

/**
 * `del.DeliveryRescheduled` v1 (FR-DEL-003, FR-DEL-011, B11 continued 5): a delivery booked another slot of its zone (the
 * first freed and the second taken in the same transaction). `reattempt` is a failed delivery sent out again: ORD moved
 * the order from DELIVERY_FAILED back to DISPATCHED in the same transaction. NTF tells the customer (FR-DEL-003).
 */
export interface DeliveryRescheduled {
  readonly deliveryId: string;
  readonly deliveryNo: string;
  readonly orderDocumentId: string;
  readonly branchId: string;
  readonly fromSlotId: string | null;
  readonly toSlotId: string;
  readonly slotDate: string;
  readonly slotStartsAt: string;
  readonly slotEndsAt: string;
  readonly reattempt: boolean;
  readonly reason: string;
  readonly rescheduledAt: string;
}
