/**
 * DEL's public door (MODULE_BOUNDARIES, DEL card). B07 continued 2 publishes `Slots`: SHP lists a zone's coming slots
 * for the shopper and names one in a checkout (`slotIn`); the seed generates them. B11 continued publishes `Deliveries`:
 * ORD's dispatch makes a delivery in its transaction (`scheduleIn`) and reads an order's (`ofOrderIn`); ORD subscribes
 * to `del.DeliveryCompleted`. B11 continued 2 publishes `DriverCashReconciliations`: POS's hand-in at a till shift
 * records a driver's cash in its transaction (`receiveIn`). B11 continued 3 publishes `Routes` (a driver's run) and ORD
 * subscribes to `del.DeliveryFailed`; `del.DeliveryOnTheWay` and `del.RouteCompleted` are for NTF and the reports.
 * B11 continued 5 adds the reassignment and the reschedule: ORD subscribes to `del.DeliveryReassigned` (the goods
 * moved van to van) and `del.DeliveryRescheduled` (a reattempt moves the order back to DISPATCHED).
 */
export { DelModule } from './del.module';
export { Deliveries, DELIVERY_COMPLETED, DELIVERY_FAILED, DELIVERY_ON_THE_WAY, DELIVERY_RETURNED, DELIVERY_WRITTEN_OFF, type DeliveryRequest, type DeliverySummaryView, type DeliveryView, type VanDelivery } from './application/deliveries';
export type { ContentsLine } from './application/delivery-store';
export { DriverCashReconciliations, type DriverCashHolderView, type DriverCashReconciliationView, type HandInRequest } from './application/driver-cash';
export type { DeliveryCompleted, CodCollected, DriverCashRemitted, DeliveryFailed, DeliveryOnTheWay, DeliveryReassigned, DeliveryRescheduled, DeliveryReturned, DeliveryWrittenOff, RouteCompleted } from './events';
export { DELIVERY_REASSIGNED, DELIVERY_RESCHEDULED } from './application/scheduling';
export { Routes, ROUTE_COMPLETED, type RouteView } from './application/routes';
export { Slots, type DeliverySlotView, type SlotFacts, type SlotOptionView } from './application/slots';
export { DeliveryInvalidError } from './application/errors';
