/**
 * DEL's public door (MODULE_BOUNDARIES, DEL card). B07 continued 2 publishes `Slots`: SHP lists a zone's coming slots
 * for the shopper and names one in a checkout (`slotIn`); the seed generates them. B11 continued publishes `Deliveries`:
 * ORD's dispatch makes a delivery in its transaction (`scheduleIn`) and reads an order's (`ofOrderIn`); ORD subscribes
 * to `del.DeliveryCompleted`. B11 continued 2 publishes `DriverCashReconciliations`: POS's hand-in at a till shift
 * records a driver's cash in its transaction (`receiveIn`). B11 continued 3 publishes `Routes` (a driver's run) and ORD
 * subscribes to `del.DeliveryFailed`; `del.DeliveryOnTheWay` and `del.RouteCompleted` are for NTF and the reports.
 */
export { DelModule } from './del.module';
export { Deliveries, DELIVERY_COMPLETED, DELIVERY_FAILED, DELIVERY_ON_THE_WAY, type DeliveryRequest, type DeliverySummaryView, type DeliveryView } from './application/deliveries';
export type { ContentsLine } from './application/delivery-store';
export { DriverCashReconciliations, type DriverCashReconciliationView, type HandInRequest } from './application/driver-cash';
export type { DeliveryCompleted, CodCollected, DriverCashRemitted, DeliveryFailed, DeliveryOnTheWay, RouteCompleted } from './events';
export { Routes, ROUTE_COMPLETED, type RouteView } from './application/routes';
export { Slots, type DeliverySlotView, type SlotFacts, type SlotOptionView } from './application/slots';
