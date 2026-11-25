import { farmSeedAud, farmSeedOfflineSettings } from './farm-aud';
import { farmSeedBil } from './farm-bil';
import { farmSeedCap } from './farm-cap';
import { farmSeedFin, farmSeedFinAssets } from './farm-fin';
import { farmSeedIam, seedLocationGrantsIam } from './farm-iam';
import { farmSeedInv } from './farm-inv';
import { farmSeedLiv } from './farm-liv';
import { farmSeedMdm, farmSeedMdmBootstrap } from './farm-mdm';
import { farmSeedMdmUnits } from './farm-mdm-units';
import { farmSeedOrd } from './farm-ord';
import { farmSeedPrc } from './farm-prc';
import { farmSeedPur } from './farm-pur';
import { farmSeedPurRegister } from './farm-pur-register';
import { farmSeedPurCredit } from './farm-pur-credit';
import { farmSeedShp } from './farm-shp';
import { farmSeedQuo } from './farm-quo';
import { farmSeedRpt } from './farm-rpt';
import { farmSeedWhl, farmSeedWhlAccounts, farmSeedWhlDunning } from './farm-whl';
import { seedRunCalendar } from './seed-calendar';
import type { SeedUnit } from './seed-unit';

/** What the seed units read from the environment. Values here are development secrets, generated per machine. */
export interface SeedEnvironment {
  readonly SEED_STAFF_PASSWORD?: string | undefined;
}

/** What a seed run adds to the farm. */
export interface SeedOptions {
  /**
   * The seeded trading day of sales, posted through ORD's `SalePosting` after the farm (B09a continued 2g, A-234).
   * `pnpm db:seed` always adds it; a test adds it only when it reads the day, so the farm the other tests load keeps
   * the B5 hand count and every exact amount they assert.
   */
  readonly tradingDay?: boolean;
  /**
   * The investors, their capital and the trading summary of July to September 2026 (B12, UAT section 3.5, `farm-cap.ts`).
   * `pnpm db:seed` always adds them; a test adds them only when it reads them, so the bank balance and the ledger every
   * other test asserts stay as they were.
   */
  readonly investors?: boolean;
  /**
   * The reporting slice (B12 continued 4, A-392, `farm-rpt.ts`): two investors' portal logins, a posted CST labour run,
   * and the daily exception report's day with an item of every kind. Needs `investors` and `tradingDay`. `pnpm db:seed`
   * always adds it; a test adds it only when it reads it, so the ledger and the purchase orders every other test asserts
   * stay as they were.
   */
  readonly reporting?: boolean;
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
 * delivery slots through DEL and the storefront's listing is built through SHP (B07 continued 2); last, the trading day's
 * billing documents (an invoice on terms, a walk-in receipt, a credit note approved by the Manager, a debit note and a
 * proforma) are issued through BIL and posted by the ledger (B08 continued 2); then the Accountant issues Tema Cold
 * Store's statement for the thirty days to today through WHL (B08 continued 2d, `farm-whl.ts`); then three business accounts, each credit limit
 * asked by one Owner or Manager and approved by another, Madina Market Traders held by the Accountant (B10 continued, `farm-whl.ts`); then the reminder levels of 7, 14 and 30 days
 * (B10 continued 2, `farm-whl.ts`); then the seeded Owner sets the business
 * profile through AUD, the shop's contact details among it (B09x continued, `farm-aud.ts`); then the seeded salesperson logs Madina Market
 * Traders' WhatsApp request for ten crates and drafts its quote through QUO, nothing reserved (B10, `farm-quo.ts`); then, with `investors`, the Accountant registers the five investors of UAT section 3.5, records their
 * contributions and the trading summary of July to September 2026, which the Owner approves (B12, `farm-cap.ts`); last, with `tradingDay`, the seeded cashier posts
 * the trading day's sales through ORD's `SalePosting` (B09a continued 2g, `farm-ord.ts`); last, with `reporting`, the Accountant opens two investors'
 * portal logins, a CST labour run is made and posted, and the exception report's day is seeded (B12 continued 4, `farm-rpt.ts`). Every date the units write comes from one
 * seed calendar per run, built from the application clock (B09t2, `seed-calendar.ts`).
 */
export function seedUnits(env: SeedEnvironment, options: SeedOptions = {}): readonly SeedUnit[] {
  const calendar = seedRunCalendar();
  const farm = [farmSeedMdmBootstrap(), farmSeedIam(env.SEED_STAFF_PASSWORD), farmSeedMdm(calendar), seedLocationGrantsIam(), farmSeedInv(calendar), farmSeedLiv(calendar), farmSeedMdmUnits(), farmSeedPrc(), farmSeedFin(), farmSeedFinAssets(), farmSeedPur(), farmSeedPurRegister(), farmSeedPurCredit(), farmSeedShp(), farmSeedBil(), farmSeedWhl(calendar), farmSeedWhlAccounts(), farmSeedWhlDunning(), farmSeedAud(), farmSeedOfflineSettings(), farmSeedQuo(calendar)];
  const withInvestors = options.investors === true ? [...farm, farmSeedCap()] : farm;
  const withTradingDay = options.tradingDay === true ? [...withInvestors, farmSeedOrd(calendar)] : withInvestors;
  if (options.reporting === true && (options.investors !== true || options.tradingDay !== true)) {
    throw new Error('the reporting seed needs the investors and the trading day: pass investors and tradingDay with reporting');
  }
  return options.reporting === true ? [...withTradingDay, farmSeedRpt()] : withTradingDay;
}
