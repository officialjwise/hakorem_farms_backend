/**
 * SHP's public door (MODULE_BOUNDARIES, SHP card). No module imports SHP; the worker runs `CatalogueListing.refresh`
 * as the `catalogue-refresh` job and `AbandonedCarts.run` as `abandoned-carts` (B11 continued 12) and the seed refreshes it once the farm is stocked. Events are in `events.ts`.
 */
export { ShpModule } from './shp.module';
export { CatalogueListing } from './application/catalogue';
export { AbandonedCarts, CART_ABANDONED } from './application/abandoned-carts';
export type { CartAbandoned, CheckoutEnded, CheckoutStarted } from './events';
