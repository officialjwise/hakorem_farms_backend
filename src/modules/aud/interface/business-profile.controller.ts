import { Body, Controller, Get, Inject, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { BusinessProfiles, type BusinessProfileView } from '../application/business-profiles';
import { BusinessProfileUpdate } from './schemas';

/** The business profile (FR-AUD-008). The controller parses and delegates; the handler authorises and decides. */
@Controller('admin/business-profile')
export class BusinessProfileController {
  constructor(@Inject(BusinessProfiles) private readonly profiles: BusinessProfiles) {}

  @Get()
  @Operation({ operationId: 'getBusinessProfile', access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console', permission: 'aud.setting.read' })
  getBusinessProfile(@CurrentActor() actor: Actor | undefined): Promise<BusinessProfileView> {
    return this.profiles.get(actor);
  }

  @Put()
  @Operation({ operationId: 'updateBusinessProfile', access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console', permission: 'aud.setting.manage' })
  async updateBusinessProfile(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(BusinessProfileUpdate)) body: z.infer<typeof BusinessProfileUpdate>,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BusinessProfileView> {
    const response = await this.profiles.update(actor, body, idempotencyKey);
    res.status(response.status);
    return response.body;
  }
}
