import { Money } from '@hakorem/kernel';
import type { RoleRecord } from './access-store';

/** The contract's `Role`, money as JSON integers of pesewas. */
export interface RoleView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isSystem: boolean;
  readonly requiresTotp: boolean;
  readonly permissions: readonly string[];
  readonly limits: ReadonlyArray<{ readonly limitKind: string; readonly amountPesewas: number }>;
  readonly userCount: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A role as the contract shows it: each limit as the contract's JSON integer of pesewas (ADR-0001). */
export function roleView(role: RoleRecord): RoleView {
  return {
    id: role.id,
    code: role.code,
    name: role.name,
    isSystem: role.isSystem,
    requiresTotp: role.requiresTotp,
    permissions: role.permissions,
    limits: role.limits.map((limit) => ({ limitKind: limit.limitKind, amountPesewas: Money.ofPesewas(limit.amountPesewas).toJsonInteger() })),
    userCount: role.userCount,
    version: role.version,
    createdAt: role.createdAt.toISOString(),
    updatedAt: role.updatedAt.toISOString(),
  };
}

/** An optional amount as the contract's JSON integer of pesewas (ADR-0001). */
export function pesewasJson(amount: bigint | null): number | null {
  return amount === null ? null : Money.ofPesewas(amount).toJsonInteger();
}
