import { farmSeedIam, seedLocationGrantsIam } from './farm-iam';
import { farmSeedMdm, farmSeedMdmBootstrap } from './farm-mdm';
import type { SeedUnit } from './seed-unit';

/** What the seed units read from the environment. Values here are development secrets, generated per machine. */
export interface SeedEnvironment {
  readonly SEED_STAFF_PASSWORD?: string | undefined;
}

/**
 * The seed units, in the order they run. Each module session appends its unit here, so later sessions inherit a
 * realistic farm. MDM's bootstrap writes the first branch (ADR-0042); IAM's service unit bootstraps the Owner there
 * (ADR-0043), who creates one staff member per role; the MDM service unit then writes, as the seeded staff, the test branch, Dodowa's locations, the customers,
 * the catalogue, the tax scheme, the approved price lists, the caterer's contract list and the promotions through
 * MDM's services; last, the Owner grants the staff scoped to a location once the locations exist.
 */
export function seedUnits(env: SeedEnvironment): readonly SeedUnit[] {
  return [farmSeedMdmBootstrap(), farmSeedIam(env.SEED_STAFF_PASSWORD), farmSeedMdm(), seedLocationGrantsIam()];
}
