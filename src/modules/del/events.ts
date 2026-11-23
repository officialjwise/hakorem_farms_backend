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
