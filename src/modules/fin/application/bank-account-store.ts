import type { Transaction } from '../../../platform/database/unit-of-work';
import type { BankAccountKind } from '../domain/bank-account';

export const BANK_ACCOUNT_STORE = Symbol('BANK_ACCOUNT_STORE');

/** A bank account as FIN reads it: never the sealed number, only its last four digits. */
export interface BankAccountRow {
  readonly id: string;
  readonly kind: BankAccountKind;
  readonly name: string;
  readonly institution: string;
  readonly accountNoLast4: string;
  readonly glAccountId: string;
  readonly glAccountCode: string;
  readonly glAccountName: string;
  readonly branchId: string | null;
  readonly isActive: boolean;
  readonly version: number;
}

/** What is written for a new account: the number only as its sealed parts (ADR-0057). */
export interface NewBankAccount {
  readonly id: string;
  readonly kind: BankAccountKind;
  readonly name: string;
  readonly institution: string;
  readonly accountNoEnc: Buffer;
  readonly accountNoDataKey: Buffer;
  readonly accountNoKekVersion: number;
  readonly accountNoLast4: string;
  readonly glAccountId: string;
  readonly branchId: string | null;
}

export interface BankAccountStore {
  list(tx: Transaction, after: { readonly name: string; readonly id: string } | null, limit: number): Promise<BankAccountRow[]>;
  find(tx: Transaction, id: string, forUpdate: boolean): Promise<BankAccountRow | null>;
  findMany(tx: Transaction, ids: readonly string[]): Promise<BankAccountRow[]>;
  nameTaken(tx: Transaction, name: string, exceptId: string | null): Promise<boolean>;
  glAccountIdOf(tx: Transaction, code: string): Promise<string | null>;
  insert(tx: Transaction, row: NewBankAccount, actorId: string): Promise<void>;
  update(tx: Transaction, id: string, change: { readonly name: string; readonly isActive: boolean }, actorId: string): Promise<void>;
}
