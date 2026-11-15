import { farmSeedIam, seedLocationGrantsIam } from './farm-iam';
import { farmSeedInv } from './farm-inv';
import { farmSeedLiv } from './farm-liv';
import { farmSeedMdm, farmSeedMdmBootstrap } from './farm-mdm';
import { farmSeedPrc } from './farm-prc';
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
 * MDM's services; then the Owner grants the staff scoped to a location once the locations exist; last, the Manager
 * registers the suppliers and receives the farm's stock through INV's goods receipts (B05 continued), weighs the animals the receipts opened in the register through
 * LIV (B06 continued), and sets the goat's yield standards through PRC (B6).
 */
export function seedUnits(env: SeedEnvironment): readonly SeedUnit[] {
  return [farmSeedMdmBootstrap(), farmSeedIam(env.SEED_STAFF_PASSWORD), farmSeedMdm(), seedLocationGrantsIam(), farmSeedInv(), farmSeedLiv(), farmSeedPrc()];
}
