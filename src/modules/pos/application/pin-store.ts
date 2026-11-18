import type { Transaction } from '../../../platform/database/unit-of-work';

/** A till PIN verifier as stored (`pos.till_pin`): never logged, never returned but to an enrolled till of the branch. */
export interface TillPinRecord {
  readonly id: string;
  readonly principalId: string;
  readonly version: number;
  readonly algorithm: string;
  readonly iterations: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
  readonly setAt: Date;
  readonly recordedAt: Date;
  /** When a newer version of the same person was set; null while it is in force. */
  readonly supersededAt: Date | null;
}

export type PinEventOutcome = 'FAILED' | 'SUCCEEDED';
export type PinEventPurpose = 'UNLOCK' | 'APPROVAL' | 'WITNESS' | 'SIGN_OUT';

/** A PIN try a till reported (`pos.till_pin_event`), once by its client id. */
export interface TillPinEventRecord {
  readonly id: string;
  readonly registerId: string;
  readonly deviceId: string;
  readonly branchId: string;
  readonly principalId: string;
  readonly pinVersion: number;
  readonly outcome: PinEventOutcome;
  readonly purpose: PinEventPurpose;
  readonly occurredAt: Date;
  readonly receivedAt: Date;
  readonly recordedAt: Date;
  readonly actorId: string;
}

/** A locked cashier signed out of a till by a supervisor's PIN (`pos.till_sign_out`), once by its client id. */
export interface TillSignOutRecord {
  readonly id: string;
  readonly registerId: string;
  readonly deviceId: string;
  readonly branchId: string;
  readonly shiftId: string | null;
  readonly cashierId: string;
  readonly supervisorId: string;
  readonly supervisorPinVersion: number;
  readonly occurredAt: Date;
  readonly receivedAt: Date;
  readonly recordedAt: Date;
  readonly actorId: string;
}

export const PIN_STORE = Symbol('PIN_STORE');

/** POS's store for the till PIN (ADR-0080). */
export interface PinStore {
  /** Each person's newest verifier, of those named. */
  latestPins(tx: Transaction, principalIds: readonly string[]): Promise<TillPinRecord[]>;
  /** One version of a person's verifier, with when it was replaced. */
  pinVersion(tx: Transaction, principalId: string, version: number): Promise<TillPinRecord | null>;
  /** Whether any person's verifier already uses this salt: a till that gives the same salt twice has no secure generator. */
  saltUsed(tx: Transaction, salt: Buffer): Promise<boolean>;
  insertPin(tx: Transaction, record: Omit<TillPinRecord, 'supersededAt'>): Promise<void>;
  /** The wrong tries counted against a version at or before a moment (every one with no moment). */
  wrongTries(tx: Transaction, principalId: string, version: number, at: Date | null): Promise<number>;
  /** The wrong tries counted against each of several people's versions, every one. */
  wrongTriesOf(tx: Transaction, pins: readonly { readonly principalId: string; readonly version: number }[]): Promise<ReadonlyMap<string, number>>;
  eventById(tx: Transaction, id: string): Promise<TillPinEventRecord | null>;
  insertEvent(tx: Transaction, record: TillPinEventRecord): Promise<void>;
  signOutById(tx: Transaction, id: string): Promise<TillSignOutRecord | null>;
  insertSignOut(tx: Transaction, record: TillSignOutRecord): Promise<void>;
}

/** The key the wrong-try map uses for a person's version. */
export function pinKey(principalId: string, version: number): string {
  return `${principalId}:${version}`;
}
