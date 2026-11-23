/**
 * DEL's public door (MODULE_BOUNDARIES, DEL card). B07 continued 2 publishes `Slots`: SHP lists a zone's coming slots
 * for the shopper and names one in a checkout (`slotIn`); the seed generates them. B11 continued publishes `Deliveries`:
 * ORD's dispatch makes a delivery in its transaction (`scheduleIn`) and reads an order's (`ofOrderIn`); ORD subscribes
 * to `del.DeliveryCompleted`.
 */
export { DelModule } from './del.module';
export { Deliveries, DELIVERY_COMPLETED, type DeliveryRequest, type DeliverySummaryView, type DeliveryView } from './application/deliveries';
export type { ContentsLine } from './application/delivery-store';
export type { DeliveryCompleted, CodCollected } from './events';
export { Slots, type DeliverySlotView, type SlotFacts, type SlotOptionView } from './application/slots';
