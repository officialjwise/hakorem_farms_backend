import { farmSeedB3 } from './farm-b3';
import type { SeedUnit } from './seed-unit';

/** What the seed units read from the environment. Values here are development secrets, generated per machine. */
export interface SeedEnvironment {
  readonly SEED_STAFF_PASSWORD?: string | undefined;
}

/**
 * The seed units, in the order they run. Each module session appends its unit here, so later sessions inherit a
 * realistic farm: B3 adds the branches, locations, catalogue basics and one staff member per role.
 */
export function seedUnits(env: SeedEnvironment): readonly SeedUnit[] {
  return [farmSeedB3(env.SEED_STAFF_PASSWORD)];
}
