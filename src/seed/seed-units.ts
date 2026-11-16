import { farmSeedIam, seedLocationGrantsIam } from './farm-iam';
import { farmSeedInv } from './farm-inv';
import { farmSeedLiv } from './farm-liv';
import { farmSeedMdm, farmSeedMdmBootstrap } from './farm-mdm';
import { farmSeedMdmUnits } from './farm-mdm-units';
import { farmSeedPrc } from './farm-prc';
import { farmSeedPur } from './farm-pur';
import { farmSeedPurRegister } from './farm-pur-register';
import { farmSeedPurCredit } from './farm-pur-credit';
import { farmSeedShp } from './farm-shp';
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
 * LIV (B06 continued), gives the feed bags and the cabbage crate their exact conversions through MDM (B06u), and sets the
 * goat's yield standards through PRC (B6); then the Manager orders feed by the bag and sends the order, and the Accountant
 * enters and approves the goats' transport invoice through PUR (B7); last, Kpone's terms, two suppliers' payout details
 * (made by the Owner, approved by the Manager) and a feed requisition go in through PUR (B07 continued); then the Accountant
 * enters Kpone's transport credit note and the Owner approves it (B07 continued 1b); last, the Manager generates Dodowa's
 * delivery slots through DEL and the storefront's listing is built through SHP (B07 continued 2).
 */
export function seedUnits(env: SeedEnvironment): readonly SeedUnit[] {
  return [farmSeedMdmBootstrap(), farmSeedIam(env.SEED_STAFF_PASSWORD), farmSeedMdm(), seedLocationGrantsIam(), farmSeedInv(), farmSeedLiv(), farmSeedMdmUnits(), farmSeedPrc(), farmSeedPur(), farmSeedPurRegister(), farmSeedPurCredit(), farmSeedShp()];
}
