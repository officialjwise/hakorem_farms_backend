/**
 * SHP's public door (MODULE_BOUNDARIES, SHP card). No module imports SHP; the worker runs `CatalogueListing.refresh`
 * as the `catalogue-refresh` job and the seed refreshes it once the farm is stocked. Events are in `events.ts`.
 */
export { ShpModule } from './shp.module';
export { CatalogueListing } from './application/catalogue';
export type { CheckoutEnded, CheckoutStarted } from './events';
