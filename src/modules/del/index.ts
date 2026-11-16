/**
 * DEL's public door (MODULE_BOUNDARIES, DEL card). B07 continued 2 publishes `Slots`: SHP lists a zone's coming slots
 * for the shopper and names one in a checkout (`slotIn`); the seed generates them. The rest of the module is B11's.
 */
export { DelModule } from './del.module';
export { Slots, type DeliverySlotView, type SlotFacts, type SlotOptionView } from './application/slots';
