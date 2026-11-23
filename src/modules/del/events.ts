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
