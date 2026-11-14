import type { SeedUnit } from './seed-unit';

/**
 * The seed units, in the order they run. B2 has no module tables, so there is nothing to seed yet; each module
 * session from B3 appends its unit here, so later sessions inherit a realistic farm.
 */
export const SEED_UNITS: readonly SeedUnit[] = [];
