import type { Transaction } from '../../../platform/database/unit-of-work';
import type { PlaceUsage } from '../domain/locations';

/**
 * The port by which a higher module tells master data whether a branch or a location is in use (ADR-0051): stock
 * standing there, or open documents naming it. Each call runs in the caller's transaction, reads only the
 * implementing module's own schema, authorises nothing and writes nothing. INV implements it from B05x; PUR, ORD and
 * DEL add theirs when their documents exist.
 */
export interface LocationUsageCheck {
  branchUsage(tx: Transaction, branchId: string): Promise<PlaceUsage>;
  locationUsage(tx: Transaction, locationId: string): Promise<PlaceUsage>;
}

/** Every registered check, asked together: stock if any check finds it, and the sum of their open documents. */
export class LocationUsageRegistry {
  private readonly checks: LocationUsageCheck[] = [];

  register(check: LocationUsageCheck): void {
    this.checks.push(check);
  }

  branchUsage(tx: Transaction, branchId: string): Promise<PlaceUsage> {
    return this.combine((check) => check.branchUsage(tx, branchId));
  }

  locationUsage(tx: Transaction, locationId: string): Promise<PlaceUsage> {
    return this.combine((check) => check.locationUsage(tx, locationId));
  }

  /** One check at a time on the one transaction: a pg client runs one query at a time. */
  private async combine(ask: (check: LocationUsageCheck) => Promise<PlaceUsage>): Promise<PlaceUsage> {
    let holdsStock = false;
    let openDocuments = 0;
    for (const check of this.checks) {
      const usage = await ask(check);
      holdsStock = holdsStock || usage.holdsStock;
      openDocuments += usage.openDocuments;
    }
    return { holdsStock, openDocuments };
  }
}
