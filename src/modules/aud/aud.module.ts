import { Module } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { CLOCK } from '../../platform/platform.module';
import { Settings } from '../../platform/settings/settings';
import { Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { SettingsAdmin } from './application/settings-admin';
import { SettingsController } from './interface/settings.controller';

/**
 * AUD (layer 3): audit, compliance and administration. From B07 continued, the audited administration of settings
 * (FR-AUD-007, `updateSetting`), first for the purchase order approval limit (A-168). Reading the audit log, number
 * series, the business profile, retention and data-subject requests arrive in their phases.
 */
@Module({
  imports: [IamModule],
  controllers: [SettingsController],
  providers: [
    {
      provide: SettingsAdmin,
      useFactory: (uow: UnitOfWork, settings: Settings, authoriser: Authoriser, idempotency: Idempotency, audit: AuditTrail, principals: PrincipalNames, clock: Clock) =>
        new SettingsAdmin(uow, settings, authoriser, idempotency, audit, principals, clock),
      inject: [UnitOfWork, Settings, Authoriser, Idempotency, AuditTrail, PRINCIPAL_NAMES, CLOCK],
    },
  ],
  exports: [SettingsAdmin],
})
export class AudModule {}
