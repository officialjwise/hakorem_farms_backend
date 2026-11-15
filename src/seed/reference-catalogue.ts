/**
 * The reference catalogue's categories and species as seed data (shared brief, "Reference catalogue"; hakorem-seed),
 * written through MDM's services by farm-mdm.ts. Products, grades and weight bands are in reference-pricing.ts, beside
 * the prices that use them.
 */

export interface SeedCategory {
  readonly code: 'LIVE' | 'MEAT' | 'EGGS' | 'PRODUCE';
  readonly name: string;
  readonly productLine: 'LIVE' | 'MEAT' | 'PRODUCE';
  readonly glGroup: 'LIVE_ANIMALS' | 'MEAT' | 'PRODUCE_EGGS';
  /** The tax category code (migration 0009) its products default to. */
  readonly taxCategory: 'LIVE_ANIMALS' | 'PROCESSED_MEAT' | 'EGGS' | 'RAW_PRODUCE';
  readonly sortOrder: number;
}

export const SEED_CATEGORIES: readonly SeedCategory[] = [
  { code: 'LIVE', name: 'Live animals', productLine: 'LIVE', glGroup: 'LIVE_ANIMALS', taxCategory: 'LIVE_ANIMALS', sortOrder: 1 },
  { code: 'MEAT', name: 'Meat', productLine: 'MEAT', glGroup: 'MEAT', taxCategory: 'PROCESSED_MEAT', sortOrder: 2 },
  { code: 'EGGS', name: 'Eggs', productLine: 'PRODUCE', glGroup: 'PRODUCE_EGGS', taxCategory: 'EGGS', sortOrder: 3 },
  { code: 'PRODUCE', name: 'Fresh produce', productLine: 'PRODUCE', glGroup: 'PRODUCE_EGGS', taxCategory: 'RAW_PRODUCE', sortOrder: 4 },
];

/** Goats, sheep, pigs and rabbits are tagged individuals; broilers, local chickens and ducks are kept in flocks. */
export const SEED_SPECIES_LIST: ReadonlyArray<{ readonly code: string; readonly name: string; readonly trackingDefault: 'SERIAL' | 'LOT' }> = [
  { code: 'GOAT', name: 'Goat', trackingDefault: 'SERIAL' },
  { code: 'SHEEP', name: 'Sheep', trackingDefault: 'SERIAL' },
  { code: 'PIG', name: 'Pig', trackingDefault: 'SERIAL' },
  { code: 'BROILER', name: 'Broiler chicken', trackingDefault: 'LOT' },
  { code: 'LOCAL_CHICKEN', name: 'Local chicken', trackingDefault: 'LOT' },
  { code: 'DUCK', name: 'Duck', trackingDefault: 'LOT' },
  { code: 'RABBIT', name: 'Rabbit', trackingDefault: 'SERIAL' },
];
