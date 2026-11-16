import { Body, Controller, Inject, Param, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { SettingsAdmin, type SettingView } from '../application/settings-admin';
import { SettingKeyParam, SettingUpdate } from './schemas';

/** Settings administration (FR-AUD-007). The controller parses and delegates; the handler authorises and decides. */
@Controller()
export class SettingsController {
  constructor(@Inject(SettingsAdmin) private readonly admin: SettingsAdmin) {}

  @Put('admin/settings/:key')
  @Operation({ operationId: 'updateSetting', access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console', permission: 'aud.setting.manage' })
  async updateSetting(
    @CurrentActor() actor: Actor | undefined,
    @Param('key', zodPipe(SettingKeyParam)) key: string,
    @Body(zodPipe(SettingUpdate)) body: z.infer<typeof SettingUpdate>,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SettingView> {
    const response = await this.admin.update(actor, key, body, idempotencyKey);
    res.status(response.status);
    return response.body;
  }
}
