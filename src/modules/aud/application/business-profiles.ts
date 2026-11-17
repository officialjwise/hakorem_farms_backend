import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { databaseErrorOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Settings } from '../../../platform/settings/settings';
import type { FileStore } from '../../../platform/storage/file-store';
import type { Authoriser } from '../../iam';
import {
  BUSINESS_PROFILE_DESCRIPTION,
  BUSINESS_PROFILE_KEY,
  judgeOpeningHours,
  shopProfileOf,
  type BusinessProfileValue,
  type OpeningInterval,
  type ShopProfileValue,
} from '../domain/business-profile';
import { SettingInvalidError } from './settings-admin';

const READ = 'aud.setting.read';
const MANAGE = 'aud.setting.manage';
/** The only purpose whose files are public images the shop and the documents may show (DC-01). */
const LOGO_PURPOSE = 'PRODUCT_IMAGE';

/** The contract's `BusinessProfileUpdate`, as the boundary parsed it: an optional field left out is cleared. */
export interface BusinessProfileUpdate {
  readonly version: number;
  readonly legalName: string;
  readonly tradingName: string;
  readonly tin?: string | undefined;
  readonly vatNumber?: string | undefined;
  readonly address: string;
  readonly phone: string;
  readonly whatsapp?: string | undefined;
  readonly email: string;
  readonly logoFileId?: string | undefined;
  readonly directions?: string | undefined;
  readonly openingHours?: readonly OpeningInterval[] | undefined;
}

/** The contract's `BusinessProfile`. */
export interface BusinessProfileView extends BusinessProfileValue {
  readonly version: number;
  /** When the profile in force took effect, by the application clock (ADR-0067). */
  readonly updatedAt: string;
}

/**
 * The business profile (FR-AUD-008): one effective-dated `platform.setting` row under `aud.business_profile`, never
 * reachable through `updateSetting`. Read in the console with `aud.setting.read` (the Owner and the Manager), changed only
 * by a holder of `aud.setting.manage` with a fresh step-up (the Owner), each change a new row from now carrying the
 * previous version plus one, audited with the profile before and after. The shop reads `shopProfile`, which hands out
 * the contact fields only (CR-028).
 */
export class BusinessProfiles {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly settings: Settings,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly files: FileStore,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  get(actor: Actor | undefined): Promise<BusinessProfileView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ, {});
      const view = await this.inForceIn(tx);
      if (view === null) throw new NotFoundError('no business profile is set');
      return view;
    });
  }

  /** The shop's contact details (CR-028), or null while no profile is set. Anonymous: it carries nothing else. */
  shopProfile(): Promise<ShopProfileValue | null> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const view = await this.inForceIn(tx);
      return view === null ? null : shopProfileOf(view);
    });
  }

  update(actor: Actor | undefined, body: BusinessProfileUpdate, idempotencyKey: string): Promise<StoredResponse<BusinessProfileView>> {
    return this.uow
      .run({ isolation: 'serializable' }, async (tx) => {
        await this.authoriser.authorise(tx, actor, MANAGE, {});
        const claim = await this.idempotency.claim(tx, { operationId: 'updateBusinessProfile', principalId: actor!.principalId, key: idempotencyKey, request: body });
        if (claim.kind === 'REPLAY') return claim.response as StoredResponse<BusinessProfileView>;
        const hours = judgeOpeningHours(body.openingHours ?? []);
        if (!hours.ok) throw new SettingInvalidError(hours.error.field, hours.error.code);
        const logoFileId = body.logoFileId ?? null;
        if (logoFileId !== null) {
          const logo = await this.files.find(tx, logoFileId);
          if (logo === null || logo.purpose !== LOGO_PURPOSE || logo.scanStatus !== 'CLEAN' || !logo.contentType.startsWith('image/')) {
            throw new SettingInvalidError('/logoFileId', 'LOGO_NOT_USABLE');
          }
        }
        const now = this.clock.now();
        const current = await this.inForceIn(tx, now);
        if ((current?.version ?? 0) !== body.version) throw new VersionConflictError(`the business profile is at version ${current?.version ?? 0}, not ${body.version}`);
        const value: BusinessProfileValue = {
          legalName: body.legalName,
          tradingName: body.tradingName,
          tin: body.tin ?? null,
          vatNumber: body.vatNumber ?? null,
          address: body.address,
          phone: body.phone,
          whatsapp: body.whatsapp ?? null,
          email: body.email,
          logoFileId,
          directions: body.directions ?? null,
          openingHours: hours.value,
        };
        const id = this.nextId();
        const version = (current?.version ?? 0) + 1;
        await this.settings.insertIn(tx, { id, key: BUSINESS_PROFILE_KEY, branchId: null, value, valueType: 'JSON', validFrom: now, description: BUSINESS_PROFILE_DESCRIPTION, version }, actor!.principalId);
        const view: BusinessProfileView = { ...value, version, updatedAt: now.toISOString() };
        await this.audit.record(tx, {
          module: 'aud',
          action: 'UPDATE',
          entityType: 'BusinessProfile',
          entityId: id,
          before: current === null ? null : { ...current },
          after: { ...view },
        });
        const response = { status: 200, body: view };
        await this.idempotency.complete(tx, claim.id, response);
        return response;
      })
      .catch((error: unknown) => {
        const failure = databaseErrorOf(error);
        if (failure?.code === '23505' && failure.constraint === 'uq_setting_key_branch_from') throw new VersionConflictError('the business profile already changes at that instant');
        throw error;
      });
  }

  private async inForceIn(tx: Transaction, at: Date = this.clock.now()): Promise<BusinessProfileView | null> {
    const row = await this.settings.rowIn(tx, BUSINESS_PROFILE_KEY, null, at);
    if (row === null) return null;
    const value = row.value as BusinessProfileValue;
    return {
      legalName: value.legalName,
      tradingName: value.tradingName,
      tin: value.tin,
      vatNumber: value.vatNumber,
      address: value.address,
      phone: value.phone,
      whatsapp: value.whatsapp,
      email: value.email,
      logoFileId: value.logoFileId,
      directions: value.directions,
      openingHours: value.openingHours,
      version: row.version,
      updatedAt: row.validFrom.toISOString(),
    };
  }
}
