import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { DeliveryReports, MESSAGING_WEBHOOK_ACTOR } from '../application/delivery-reports';
import { MessageLog, type NotificationMessageView } from '../application/message-log';
import { Templates, type NotificationTemplateView, type Page } from '../application/templates';
import { IdParam, MessagePageQuery, ProviderParam, TemplateCreate, TemplatePageQuery, TemplatePreview } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Message templates for the back office (FR-NTF-001). Parses and delegates. */
@Controller('notification-templates')
export class TemplatesController {
  constructor(@Inject(Templates) private readonly templates: Templates) {}

  @Get()
  @Operation({ operationId: 'listNotificationTemplates', ...READ, permission: 'ntf.template.read' })
  listNotificationTemplates(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(TemplatePageQuery)) query: z.infer<typeof TemplatePageQuery>): Promise<Page<NotificationTemplateView>> {
    return this.templates.list(actor, query, query.cursor, query.limit);
  }

  @Post()
  @Operation({ operationId: 'createNotificationTemplate', ...WRITE, permission: 'ntf.template.manage' })
  createNotificationTemplate(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(TemplateCreate)) body: z.infer<typeof TemplateCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NotificationTemplateView> {
    return reply(res, this.templates.create(actor, body, key));
  }

  @Get(':id')
  @Operation({ operationId: 'getNotificationTemplate', ...READ, permission: 'ntf.template.read' })
  getNotificationTemplate(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<NotificationTemplateView> {
    return this.templates.get(actor, id);
  }

  @Post(':id/activate')
  @Operation({ operationId: 'activateNotificationTemplate', ...WRITE, permission: 'ntf.template.manage' })
  activateNotificationTemplate(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<NotificationTemplateView> {
    return reply(res, this.templates.activate(actor, id, key));
  }

  @Post(':id/preview')
  @HttpCode(200)
  @Operation({ operationId: 'previewNotificationTemplate', ...READ, csrf: true, permission: 'ntf.template.read' })
  previewNotificationTemplate(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(TemplatePreview)) body: z.infer<typeof TemplatePreview>,
  ): Promise<{ readonly subject: string | null; readonly body: string; readonly characterCount: number; readonly smsSegments: number }> {
    return this.templates.preview(actor, id, body.data);
  }
}

/** The message log for the back office (FR-NTF-007). Parses and delegates. */
@Controller('notifications/messages')
export class MessagesController {
  constructor(@Inject(MessageLog) private readonly log: MessageLog) {}

  @Get()
  @Operation({ operationId: 'listNotificationMessages', ...READ, permission: 'ntf.message.read' })
  listNotificationMessages(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(MessagePageQuery)) query: z.infer<typeof MessagePageQuery>): Promise<Page<NotificationMessageView>> {
    return this.log.list(actor, query, query.cursor, query.limit);
  }

  @Get(':id')
  @Operation({ operationId: 'getNotificationMessage', ...READ, permission: 'ntf.message.read' })
  getNotificationMessage(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<NotificationMessageView> {
    return this.log.get(actor, id);
  }

  @Post(':id/retry')
  @Operation({ operationId: 'retryNotificationMessage', ...WRITE, permission: 'ntf.message.retry' })
  retryNotificationMessage(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<NotificationMessageView> {
    return reply(res, this.log.retry(actor, id, key));
  }
}

/**
 * A messaging provider's webhook (FR-NTF-007). Public: the signature over the raw body is the only credential, checked
 * first by the handler; the route acts as the webhook's own principal, which holds no grant.
 */
@Controller('webhooks/messaging')
export class MessagingWebhooksController {
  constructor(@Inject(DeliveryReports) private readonly reports: DeliveryReports) {}

  @Post(':provider')
  @HttpCode(200)
  @Operation({ operationId: 'receiveMessagingWebhook', access: 'PUBLIC', realms: [], permission: null, idempotent: false, csrf: false, rateLimit: 'public', publicActor: MESSAGING_WEBHOOK_ACTOR })
  receiveMessagingWebhook(@Param('provider', zodPipe(ProviderParam)) provider: string, @Headers('x-provider-signature') signature: string | undefined, @Req() req: Request): Promise<{ readonly received: true }> {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    return this.reports.receive({ provider, rawBody: raw, signature, sourceIp: req.ip ?? null });
  }
}
