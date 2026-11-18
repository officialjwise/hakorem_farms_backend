import type { BusinessAccounts } from './business-accounts';

/** The worker's `account-hold` job (FR-WHL-008): the automatic release of paid system holds, then the overdue hold, run as the Scheduler. */
export class AccountHolds {
  constructor(private readonly accounts: BusinessAccounts) {}

  run(system: { readonly kind: 'SYSTEM'; readonly principalId: string }): Promise<string[]> {
    return this.accounts.holdOverdue(system);
  }

  releasePaid(system: { readonly kind: 'SYSTEM'; readonly principalId: string }): Promise<string[]> {
    return this.accounts.releasePaid(system);
  }
}
