import { createUuidV7Generator, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import { checkAccountClosing, checkNewAccount, normalSideOf, type AccountType } from '../domain/accounts';
import type { SubledgerKind } from '../domain/posting';
import type { AccountRow, CashFlowCategory, ChartStore } from './chart-store';
import { AccountCodeTakenError, AccountInvalidError, FinReferenceNotFoundError } from './errors';
import type { Page } from './periods';

export const CREATE_ACCOUNT = 'createAccount';
export const UPDATE_ACCOUNT = 'updateAccount';
const READ = 'fin.account.read';
const MANAGE = 'fin.account.manage';

/** The contract's `Account`. */
export type AccountView = AccountRow;

export interface AccountCreateRequest {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly parentId?: string | undefined;
  readonly isPostable: boolean;
  readonly subledgerKind?: SubledgerKind | undefined;
  readonly cashFlowCategory?: CashFlowCategory | undefined;
}

export interface AccountUpdateRequest {
  readonly version: number;
  readonly name?: string | undefined;
  readonly status?: 'ACTIVE' | 'CLOSED' | undefined;
}

/**
 * The chart of accounts (FR-FIN-001, FR-FIN-002): the accountant lists it, adds an account and renames, closes or
 * reopens one. Each command authorises first through IAM's policy engine, deny by default, and is audited with
 * before and after values. The chart is one book for the legal entity, so no branch scope applies (ADR-0003). The
 * database keeps a used account's code, type, side and subledger whatever writes (0123, `ck_account_change`).
 */
export class ChartOfAccounts {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: ChartStore,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, query: { readonly type?: AccountType | undefined; readonly postableOnly?: boolean | undefined }, cursor: string | undefined, limit: number): Promise<Page<AccountView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const filters = { type: query.type ?? null, postableOnly: query.postableOnly ?? false };
      const binding = { operationId: 'listAccounts', principalId: actor!.principalId, filters };
      const after = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['code'] ?? null);
      const found = await this.store.accounts(tx, filters, after, limit + 1);
      const data = found.slice(0, limit);
      const hasMore = found.length > limit;
      return { data, page: { nextCursor: hasMore ? this.cursors.encode(binding, { code: data.at(-1)!.code }) : null, limit, hasMore } };
    });
  }

  create(actor: Actor | undefined, body: AccountCreateRequest, idempotencyKey: string): Promise<StoredResponse<AccountView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId: CREATE_ACCOUNT, principalId: actor!.principalId, key: idempotencyKey, request: body });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<AccountView>;
      const parent = body.parentId === undefined ? null : await this.store.account(tx, body.parentId, false);
      if (parent === null && body.parentId !== undefined) throw new FinReferenceNotFoundError(['/parentId']);
      const row: AccountRow = {
        id: this.nextId(),
        code: body.code,
        name: body.name.trim(),
        type: body.type,
        normalSide: normalSideOf(body.type),
        parentId: parent?.id ?? null,
        isPostable: body.isPostable,
        subledgerKind: body.subledgerKind ?? null,
        cashFlowCategory: body.cashFlowCategory ?? null,
        status: 'ACTIVE',
        version: 1,
      };
      const rules = checkNewAccount(row, parent);
      if (rules.length > 0) throw new AccountInvalidError(rules);
      if (await this.store.codeTaken(tx, row.code)) throw new AccountCodeTakenError();
      await this.store.insertAccount(tx, row, actor!.principalId);
      await this.audit.record(tx, { module: 'fin', action: 'CREATE', entityType: 'Account', entityId: row.id, branchId: null, before: null, after: { ...row } });
      const response = { status: 201, body: row };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  update(actor: Actor | undefined, id: string, body: AccountUpdateRequest, idempotencyKey: string): Promise<StoredResponse<AccountView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId: UPDATE_ACCOUNT, principalId: actor!.principalId, key: idempotencyKey, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<AccountView>;
      const before = await this.store.account(tx, id, true);
      if (before === null) throw new NotFoundError(`no account ${id}`);
      if (before.version !== body.version) throw new VersionConflictError(`account ${before.code} is at version ${before.version}`);
      const change = { name: body.name?.trim() ?? before.name, status: body.status ?? before.status };
      if (change.status === 'CLOSED' && before.status === 'ACTIVE') {
        await this.refuseClosing(tx, before);
      }
      await this.store.updateAccount(tx, id, change, actor!.principalId);
      const after = (await this.store.account(tx, id, false))!;
      await this.audit.record(tx, {
        module: 'fin',
        action: 'UPDATE',
        entityType: 'Account',
        entityId: id,
        branchId: null,
        before: { name: before.name, status: before.status, version: before.version },
        after: { name: after.name, status: after.status, version: after.version },
      });
      const response = { status: 200, body: after };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** A closed account takes no new lines (A-188): it closes only at a nil balance and once nothing in force posts to it. */
  private async refuseClosing(tx: Transaction, account: AccountRow): Promise<void> {
    const rules = checkAccountClosing({
      balancePesewas: await this.store.accountBalance(tx, account.id),
      namedInForce: await this.store.accountNamedInForce(tx, account.id, toBusinessDate(this.clock.now())),
    });
    if (rules.length > 0) throw new AccountInvalidError(rules);
  }
}
