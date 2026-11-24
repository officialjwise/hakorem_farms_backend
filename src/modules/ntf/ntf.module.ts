import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DomainEvents } from '../../platform/events/domain-events';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { SMS_CHANNEL, type NotificationChannel } from '../../platform/notifications/notification-channel';
import { CLOCK, LOGGER } from '../../platform/platform.module';
import { DelModule, Slots } from '../del';
import { Authoriser, IamModule } from '../iam';
import { MasterDataRefs, MdmModule } from '../mdm';
import { OrdModule, Orders } from '../ord';
import { AddressHasher, CustomerMessages } from './application/customer-messages';
import { DeliveryReports } from './application/delivery-reports';
import { MessageLog } from './application/message-log';
import { MessageSender } from './application/message-sender';
import { NTF_STORE, type NtfStore } from './application/ntf-store';
import { Templates } from './application/templates';
import { PgNtfStore } from './infrastructure/pg-ntf-store';
import { MessagesController, MessagingWebhooksController, TemplatesController } from './interface/ntf.controller';

/**
 * NTF (layer 11): notifications. B11 continued 10 builds its first pass (A-374): message templates by version, the
 * customer's messages from ORD's and DEL's events through the outbox, the sender the worker runs, the message log with
 * each attempt and a provider's signed delivery reports. Preferences, opt-outs, quiet hours, triggers, in-app
 * notifications, the document sends and the reminders follow in B11 continued 11. Nothing calls NTF (MODULE_BOUNDARIES).
 */
@Module({
  imports: [IamModule, MdmModule, DelModule, OrdModule],
  controllers: [TemplatesController, MessagesController, MessagingWebhooksController],
  providers: [
    { provide: NTF_STORE, useClass: PgNtfStore },
    { provide: AddressHasher, useFactory: (config: AppConfig) => new AddressHasher(Buffer.from(config.LOOKUP_HMAC_KEY, 'base64')), inject: [APP_CONFIG] },
    {
      provide: Templates,
      useFactory: (uow: UnitOfWork, store: NtfStore, authoriser: Authoriser, idempotency: Idempotency, audit: AuditTrail, cursors: Cursors, clock: Clock) => new Templates(uow, store, authoriser, idempotency, audit, cursors, clock),
      inject: [UnitOfWork, NTF_STORE, Authoriser, Idempotency, AuditTrail, Cursors, CLOCK],
    },
    {
      provide: MessageLog,
      useFactory: (uow: UnitOfWork, store: NtfStore, refs: MasterDataRefs, orders: Orders, authoriser: Authoriser, idempotency: Idempotency, audit: AuditTrail, cursors: Cursors, clock: Clock) =>
        new MessageLog(uow, store, refs, orders, authoriser, idempotency, audit, cursors, clock),
      inject: [UnitOfWork, NTF_STORE, MasterDataRefs, Orders, Authoriser, Idempotency, AuditTrail, Cursors, CLOCK],
    },
    {
      provide: CustomerMessages,
      useFactory: (store: NtfStore, orders: Orders, slots: Slots, events: DomainEvents, hasher: AddressHasher, clock: Clock) => new CustomerMessages(store, orders, slots, events, hasher, clock),
      inject: [NTF_STORE, Orders, Slots, DomainEvents, AddressHasher, CLOCK],
    },
    {
      provide: MessageSender,
      useFactory: (uow: UnitOfWork, store: NtfStore, orders: Orders, sms: NotificationChannel, events: DomainEvents, hasher: AddressHasher, clock: Clock, logger: Logger) =>
        new MessageSender(uow, store, orders, new Map([['SMS', sms]]), events, hasher, clock, logger),
      inject: [UnitOfWork, NTF_STORE, Orders, SMS_CHANNEL, DomainEvents, AddressHasher, CLOCK, LOGGER],
    },
    {
      provide: DeliveryReports,
      useFactory: (uow: UnitOfWork, store: NtfStore, events: DomainEvents, config: AppConfig, clock: Clock, logger: Logger) => new DeliveryReports(uow, store, events, config.SMS_WEBHOOK_SECRET, clock, logger),
      inject: [UnitOfWork, NTF_STORE, DomainEvents, APP_CONFIG, CLOCK, LOGGER],
    },
  ],
  exports: [MessageSender],
})
export class NtfModule implements OnModuleInit {
  constructor(
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(CustomerMessages) private readonly customerMessages: CustomerMessages,
  ) {}

  onModuleInit(): void {
    this.events.registerConsumer(this.customerMessages.consumer);
  }
}
