import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { databaseErrorOf, type UnitOfWork } from '../../../platform/database/unit-of-work';
import { BusinessRuleError, NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Settings } from '../../../platform/settings/settings';
import type { Authoriser, PrincipalNames } from '../../iam';
import { judgeSetting } from '../domain/setting-catalogue';

registerMessages({
  'aud.setting_invalid': 'This value is not allowed for this setting.',
});

const MANAGE = 'aud.setting.manage';

/** 422 SETTING_INVALID (FR-AUD-007): `WRONG_TYPE`, `OUT_OF_RANGE`, `IN_THE_PAST`, `NOT_BRANCH_SCOPED`. */
export class SettingInvalidError extends BusinessRuleError {
  readonly code = 'SETTING_INVALID';
  readonly messageKey = 'aud.setting_invalid';

  constructor(field: string, rule: string) {
    super('the setting value breaks a rule', [{ field, code: rule, message: translate('aud.setting_invalid') }]);
  }
}

export interface SettingUpdate {
  readonly value: unknown;
  readonly branchId?: string | undefined;
  readonly validFrom?: string | undefined;
  /** The version of the row in force for this key and branch, 0 while its default applies. */
  readonly version: number;
}

/** The contract's `Setting`. */
export interface SettingView {
  readonly key: string;
  readonly branchId: string | null;
  readonly value: unknown;
  readonly valueType: string;
  readonly validFrom: string;
  readonly description: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: { readonly id: string; readonly displayName: string };
}

/**
 * Audited administration of settings (FR-AUD-007): a setting of the catalogue changes only through here, by a holder
 * of `aud.setting.manage` with a fresh step-up, as a new effective-dated row (from now, or a later instant), so what
 * was in force when stays answerable. The audit event carries the value before and after. First the purchase order
 * approval limit (owner, 2026-11-15, A-168).
 */
export class SettingsAdmin {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly settings: Settings,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly principals: PrincipalNames,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  update(actor: Actor | undefined, key: string, body: SettingUpdate, idempotencyKey: string): Promise<StoredResponse<SettingView>> {
    return this.uow
      .run({ isolation: 'serializable' }, async (tx) => {
        await this.authoriser.authorise(tx, actor, MANAGE, body.branchId === undefined ? {} : { branchId: body.branchId });
        const claim = await this.idempotency.claim(tx, { operationId: 'updateSetting', principalId: actor!.principalId, key: idempotencyKey, request: { key, ...body } });
        if (claim.kind === 'REPLAY') return claim.response as StoredResponse<SettingView>;
        const judged = judgeSetting(key, body.value);
        if (!judged.ok && judged.error === 'UNKNOWN_SETTING') throw new NotFoundError(`no setting ${key}`);
        if (!judged.ok) throw new SettingInvalidError('/value', judged.error);
        const { definition, value } = judged.value;
        const branchId = body.branchId ?? null;
        if (branchId !== null && !definition.branchScoped) throw new SettingInvalidError('/branchId', 'NOT_BRANCH_SCOPED');
        const now = this.clock.now();
        const validFrom = body.validFrom === undefined ? now : new Date(body.validFrom);
        if (validFrom.getTime() < now.getTime()) throw new SettingInvalidError('/validFrom', 'IN_THE_PAST');
        const current = await this.settings.rowIn(tx, key, branchId, now);
        if ((current?.version ?? 0) !== body.version) throw new VersionConflictError(`setting ${key} is at version ${current?.version ?? 0}, not ${body.version}`);
        const id = this.nextId();
        await this.settings.insertIn(tx, { id, key, branchId, value, valueType: definition.valueType, validFrom, description: definition.description }, actor!.principalId);
        const row = (await this.settings.rowIn(tx, key, branchId, validFrom))!;
        const names = await this.principals.refs(tx, [row.updatedBy]);
        const view: SettingView = {
          key,
          branchId,
          value: row.value,
          valueType: row.valueType,
          validFrom: row.validFrom.toISOString(),
          description: row.description,
          version: row.version,
          updatedAt: row.updatedAt.toISOString(),
          updatedBy: names.get(row.updatedBy) ?? { id: row.updatedBy, displayName: 'Unknown' },
        };
        await this.audit.record(tx, {
          module: 'aud',
          action: 'UPDATE',
          entityType: 'Setting',
          entityId: id,
          branchId,
          before: { key, branchId, value: current?.value ?? definition.defaultValue, validFrom: current?.validFrom.toISOString() ?? null, isDefault: current === null },
          after: { key, branchId, value, validFrom: validFrom.toISOString() },
        });
        const response = { status: 200, body: view };
        await this.idempotency.complete(tx, claim.id, response);
        return response;
      })
      .catch((error: unknown) => {
        const failure = databaseErrorOf(error);
        if (failure?.code === '23505' && failure.constraint === 'uq_setting_key_branch_from') throw new VersionConflictError(`setting ${key} already changes at that instant`);
        throw error;
      });
  }
}


