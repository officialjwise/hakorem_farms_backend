import { randomBytes } from 'node:crypto';
import { databaseErrorOf, sqlStateOf, type Transaction } from '../../../platform/database/unit-of-work';
import { PUBLIC_ID_LENGTH, publicIdFrom, type PublicIdKind } from '../domain/public-id';

/** How many fresh IDs an insert tries before it gives up; at 80 bits a second try is already beyond any farm. */
export const PUBLIC_ID_ATTEMPTS = 5;

/** The unique constraint that holds each kind's public ID unique over every row (migration 0212). */
const UNIQUE_CONSTRAINT: Readonly<Record<PublicIdKind, string>> = { CUSTOMER: 'uq_customer_public_id', SUPPLIER: 'uq_supplier_public_id' };

/** No free public ID after every attempt: never expected, so it is an internal error, and nothing was written. */
export class PublicIdsExhaustedError extends Error {
  constructor(kind: PublicIdKind) {
    super(`no free ${kind.toLowerCase()} public ID after ${PUBLIC_ID_ATTEMPTS} attempts`);
    this.name = 'PublicIdsExhaustedError';
  }
}

/**
 * The source of customers' and suppliers' public IDs (B09q, ADR-0073): sixteen bytes from Node's cryptographically
 * secure generator for each, spelled by the domain's `publicIdFrom`. A provider of its own, so a test can make it
 * collide.
 */
export class PublicIds {
  next(kind: PublicIdKind): string {
    return publicIdFrom(kind, randomBytes(PUBLIC_ID_LENGTH));
  }

  /**
   * Inserts a row with a fresh public ID, in the caller's transaction: each attempt runs inside a savepoint, and one
   * refused by the kind's unique constraint is rolled back to it and tried again with a new ID, up to
   * PUBLIC_ID_ATTEMPTS. Any other failure is the caller's. Returns the ID the row was written with.
   */
  async insertWithFresh(tx: Transaction, kind: PublicIdKind, insert: (publicId: string) => Promise<void>): Promise<string> {
    for (let attempt = 1; attempt <= PUBLIC_ID_ATTEMPTS; attempt += 1) {
      const publicId = this.next(kind);
      await tx.query('SAVEPOINT public_id');
      try {
        await insert(publicId);
        await tx.query('RELEASE SAVEPOINT public_id');
        return publicId;
      } catch (error) {
        if (sqlStateOf(error) !== '23505' || databaseErrorOf(error)?.constraint !== UNIQUE_CONSTRAINT[kind]) throw error;
        await tx.query('ROLLBACK TO SAVEPOINT public_id');
      }
    }
    throw new PublicIdsExhaustedError(kind);
  }
}
