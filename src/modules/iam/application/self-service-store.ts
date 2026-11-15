import type { Transaction } from '../../../platform/database/unit-of-work';

export type OneTimePurpose = 'PHONE_VERIFY' | 'PASSWORD_RESET';

export interface OneTimeToken {
  readonly id: string;
  readonly principalId: string;
  readonly purpose: OneTimePurpose;
  readonly deviceLabel: string | null;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  /** The keyed hash of a phone code; null for a reset token, whose token is the secret. */
  readonly codeHash: Buffer | null;
}

export interface NewCustomer {
  readonly id: string;
  readonly displayName: string;
  readonly phone: string;
  readonly email: string | null;
  readonly passwordHash: string;
}

/** IAM's tables for the customer realm and password reset (A-123). Every method runs in the caller's transaction. */
export interface SelfServiceStore {
  /** Whether a live account of the realm uses this email. */
  emailTaken(tx: Transaction, realm: 'CUSTOMER', email: string): Promise<boolean>;
  /** The principal and its customer account, the customer as its own creator. */
  insertCustomer(tx: Transaction, customer: NewCustomer): Promise<void>;
  markPhoneVerified(tx: Transaction, principalId: string, now: Date): Promise<void>;
  createToken(tx: Transaction, token: OneTimeToken & { readonly tokenHash: Buffer }): Promise<void>;
  /** A token of this purpose by the hash of its secret, or null. */
  tokenByHash(tx: Transaction, tokenHash: Buffer, purpose: OneTimePurpose): Promise<OneTimeToken | null>;
  /** Spends every open token of this purpose for the principal, so only the newest one works. */
  consumeOpenTokens(tx: Transaction, principalId: string, purpose: OneTimePurpose, now: Date): Promise<void>;
}

export const SELF_SERVICE_STORE = Symbol('SELF_SERVICE_STORE');
