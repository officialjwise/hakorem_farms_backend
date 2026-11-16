import { createHmac } from 'node:crypto';
import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { KeyRing } from '../../../platform/crypto/key-ring';
import { sealWithOwnKey } from '../../../platform/crypto/value-keys';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { glCodeOf, normaliseAccountNo, type BankAccountKind } from '../domain/bank-account';
import type { SubledgerRef } from '../domain/posting';
import type { BankAccountRow, BankAccountStore } from './bank-account-store';
import { BankAccountInvalidError, FinReferenceNotFoundError } from './errors';
import type { LedgerStore } from './ledger-store';
import type { Page } from './periods';

export const CREATE_BANK_ACCOUNT = 'createBankAccount';
export const UPDATE_BANK_ACCOUNT = 'updateBankAccount';
const READ = 'fin.bank_account.read';
const MANAGE = 'fin.bank_account.manage';
/** Where the number is sealed, and the row its data key is bound to (ADR-0057). */
export const accountNoPlace = (id: string) => `fin.bank_account.account_no_enc:${id}`;
export const accountNoBinding = (id: string) => `fin.bank_account.account_no:${id}`;

/** The contract's `BankAccount`: the number only as its last four digits. */
export interface BankAccountView {
  readonly id: string;
  readonly kind: BankAccountKind;
  readonly name: string;
  readonly institution: string;
  readonly accountNoLast4: string;
  readonly glAccount: { readonly id: string; readonly code: string; readonly name: string };
  readonly branch: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly isActive: boolean;
  readonly version: number;
}

export interface BankAccountCreateRequest {
  readonly kind: BankAccountKind;
  readonly name: string;
  readonly institution: string;
  readonly accountNo: string;
  readonly branchId?: string | undefined;
}

export interface BankAccountUpdateRequest {
  readonly version: number;
  readonly name?: string | undefined;
  readonly isActive?: boolean | undefined;
}

/** What PUR learns of an account a supplier payment names (A-194): never the number. */
export interface PayoutAccountFacts {
  readonly id: string;
  readonly name: string;
  readonly kind: BankAccountKind;
  readonly last4: string;
  readonly isActive: boolean;
}

/**
 * The business's own bank accounts and wallets (FR-FIN-001's 1100 and 1110, ADR-0057, A-194). Each command authorises
 * first, deny by default; adding, renaming and deactivating need a fresh step-up (the permission's). The number is
 * sealed with a data key of its own and only its last four digits are ever read back: the store never selects the
 * sealed columns, the audit trail and the response carry `accountNoLast4`, and the idempotency record hashes the
 * request with the number replaced by a keyed digest. Each account gets its own BANK_ACCOUNT subledger party in the
 * transaction that adds it (the database holds that at commit, `ck_bank_account_party`).
 */
export class BankAccounts {
  private readonly nextId: () => string;
  private readonly digestKey: Buffer;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: BankAccountStore,
    private readonly ledgerStore: LedgerStore,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly refs: MasterDataRefs,
    private readonly keyRing: KeyRing,
    private readonly cursors: Cursors,
    clock: Clock,
    lookupKey: Buffer,
  ) {
    this.nextId = createUuidV7Generator(clock);
    this.digestKey = createHmac('sha256', lookupKey).update('hk-bank-account-number-v1').digest();
  }

  list(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<BankAccountView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const binding = { operationId: 'listBankAccounts', principalId: actor!.principalId, filters: {} };
      const position = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const after = position === null ? null : { name: position['name'] ?? '', id: position['id'] ?? '' };
      const found = await this.store.list(tx, after, limit + 1);
      const data = await this.views(tx, found.slice(0, limit));
      const hasMore = found.length > limit;
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { name: last.name.trim().toLowerCase(), id: last.id }) : null, limit, hasMore } };
    });
  }

  create(actor: Actor | undefined, body: BankAccountCreateRequest, idempotencyKey: string): Promise<StoredResponse<BankAccountView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId: CREATE_BANK_ACCOUNT, principalId: actor!.principalId, key: idempotencyKey, request: { ...body, accountNo: this.digest(body.accountNo) } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<BankAccountView>;
      const number = normaliseAccountNo(body.kind, body.accountNo);
      if (!number.ok) throw new BankAccountInvalidError([number.error]);
      const name = body.name.trim();
      if (await this.store.nameTaken(tx, name, null)) throw new BankAccountInvalidError([{ field: '/name', rule: 'NAME_TAKEN' }]);
      if (body.branchId !== undefined && !(await this.refs.branchesIn(tx, [body.branchId])).has(body.branchId)) throw new FinReferenceNotFoundError(['/branchId']);
      const glAccountId = await this.store.glAccountIdOf(tx, glCodeOf(body.kind));
      if (glAccountId === null) throw new Error(`the control account ${glCodeOf(body.kind)} is missing from the chart`);
      const id = this.nextId();
      const sealed = sealWithOwnKey(this.keyRing, number.value.accountNo, accountNoPlace(id), accountNoBinding(id));
      await this.store.insert(
        tx,
        {
          id,
          kind: body.kind,
          name,
          institution: body.institution.trim(),
          accountNoEnc: sealed.ciphertext,
          accountNoDataKey: sealed.wrappedKey,
          accountNoKekVersion: sealed.kekVersion,
          accountNoLast4: number.value.last4,
          glAccountId,
          branchId: body.branchId ?? null,
        },
        actor!.principalId,
      );
      await this.ledgerStore.subledgerPartyIn(tx, { kind: 'BANK_ACCOUNT', refId: id, displayName: name }, this.nextId());
      const view = (await this.views(tx, [(await this.store.find(tx, id, false))!]))[0]!;
      await this.audit.record(tx, { module: 'fin', action: 'CREATE', entityType: 'BankAccount', entityId: id, branchId: view.branch?.id ?? null, before: null, after: { ...view } });
      const response = { status: 201, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  update(actor: Actor | undefined, id: string, body: BankAccountUpdateRequest, idempotencyKey: string): Promise<StoredResponse<BankAccountView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId: UPDATE_BANK_ACCOUNT, principalId: actor!.principalId, key: idempotencyKey, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<BankAccountView>;
      const before = await this.store.find(tx, id, true);
      if (before === null) throw new NotFoundError(`no bank account ${id}`);
      if (before.version !== body.version) throw new VersionConflictError(`bank account ${id} is at version ${before.version}`);
      const change = { name: body.name?.trim() ?? before.name, isActive: body.isActive ?? before.isActive };
      if (change.name !== before.name && (await this.store.nameTaken(tx, change.name, id))) throw new BankAccountInvalidError([{ field: '/name', rule: 'NAME_TAKEN' }]);
      await this.store.update(tx, id, change, actor!.principalId);
      const after = (await this.store.find(tx, id, false))!;
      await this.audit.record(tx, {
        module: 'fin',
        action: 'UPDATE',
        entityType: 'BankAccount',
        entityId: id,
        branchId: before.branchId,
        before: { name: before.name, isActive: before.isActive, version: before.version },
        after: { name: after.name, isActive: after.isActive, version: after.version },
      });
      const response = { status: 200, body: (await this.views(tx, [after]))[0]! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * For PUR, through FIN's public door: the accounts supplier payments name, as the contract's `BankAccountRef` plus
   * whether each is active; an unknown id is absent. Not authorised here: the payment command or read that asks has
   * authorised its own permission (A-194).
   */
  async payoutAccountsIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, PayoutAccountFacts>> {
    const rows = await this.store.findMany(tx, [...new Set(ids)]);
    return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, kind: r.kind, last4: r.accountNoLast4, isActive: r.isActive }] as const));
  }

  /** For the ledger's posting handlers: the account's own subledger party (A-194). */
  async subledgerRefIn(tx: Transaction, id: string): Promise<SubledgerRef> {
    const row = await this.store.find(tx, id, false);
    if (row === null) throw new Error(`bank account ${id} does not exist`);
    return { kind: 'BANK_ACCOUNT', refId: row.id, displayName: row.name };
  }

  private digest(accountNo: string): string {
    return createHmac('sha256', this.digestKey).update(accountNo, 'utf8').digest('hex');
  }

  private async views(tx: Transaction, rows: readonly BankAccountRow[]): Promise<BankAccountView[]> {
    const branchIds = [...new Set(rows.flatMap((r) => (r.branchId === null ? [] : [r.branchId])))];
    const branches = branchIds.length === 0 ? new Map() : await this.refs.branchesIn(tx, branchIds);
    return rows.map((r) => {
      const branch = r.branchId === null ? undefined : branches.get(r.branchId);
      return {
        id: r.id,
        kind: r.kind,
        name: r.name,
        institution: r.institution,
        accountNoLast4: r.accountNoLast4,
        glAccount: { id: r.glAccountId, code: r.glAccountCode, name: r.glAccountName },
        branch: branch === undefined ? null : { id: branch.id, code: branch.code, name: branch.name },
        isActive: r.isActive,
        version: r.version,
      };
    });
  }
}
