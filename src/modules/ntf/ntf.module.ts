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
import { InvModule, StockUnits } from '../inv';
import { LivModule, MortalityRecords } from '../liv';
import { MasterDataRefs, MdmModule } from '../mdm';
import { OnlineOrders, OrdModule, Orders } from '../ord';
import { PosModule, ReceiptLinks } from '../pos';
import { AbandonedCarts, ShpModule } from '../shp';
import { Dunning, WhlModule } from '../whl';
import { AddressHasher, CustomerMessages } from './application/customer-messages';
import { DeliveryReports } from './application/delivery-reports';
import { LinkMessages } from './application/link-messages';
import { MessageLinks } from './application/message-links';
import { InAppNotifications } from './application/in-app';
import { MessageLog } from './application/message-log';
import { availableChannels, MessageQueue, RecipientFacts } from './application/message-queue';
import { MessageSender } from './application/message-sender';
import { NTF_STORE, type NtfStore } from './application/ntf-store';
import { OptOuts } from './application/opt-outs';
import { Preferences } from './application/preferences';
import { Reminders, StaffNotifications } from './application/reminders';
import { Templates } from './application/templates';
import { Triggers } from './application/triggers';
import { PgNtfStore } from './infrastructure/pg-ntf-store';
import { MessagesController, MessagingWebhooksController, MyNotificationsController, OptOutsController, TemplatesController, TriggersController } from './interface/ntf.controller';

/**
 * NTF (layer 11): notifications. B11 continued 10 builds its first pass (A-374): message templates by version, the
 * customer's messages from ORD's and DEL's events through the outbox, the sender the worker runs, the message log with
 * each attempt and a provider's signed delivery reports. B11 continued 11 adds triggers, preferences, opt-outs (a STOP
 * reply), quiet hours, in-app notifications, the payment reminders (WHL's dunning) and the returned death report (LIV)
 * (ADR-0097, A-376). Nothing calls NTF (MODULE_BOUNDARIES).
 */
@Module({
  imports: [IamModule, MdmModule, InvModule, LivModule, DelModule, OrdModule, PosModule, ShpModule, WhlModule],
  controllers: [TemplatesController, MessagesController, MessagingWebhooksController, TriggersController, OptOutsController, MyNotificationsController],
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
      provide: RecipientFacts,
      useFactory: (store: NtfStore, orders: Orders, refs: MasterDataRefs, hasher: AddressHasher) => new RecipientFacts(store, orders, refs, hasher),
      inject: [NTF_STORE, Orders, MasterDataRefs, AddressHasher],
    },
    {
      provide: MessageQueue,
      useFactory: (store: NtfStore, recipients: RecipientFacts, sms: NotificationChannel, events: DomainEvents, clock: Clock, logger: Logger) => new MessageQueue(store, recipients, availableChannels([sms.channel]), events, clock, logger),
      inject: [NTF_STORE, RecipientFacts, SMS_CHANNEL, DomainEvents, CLOCK, LOGGER],
    },
    {
      provide: CustomerMessages,
      useFactory: (queue: MessageQueue, orders: Orders, slots: Slots) => new CustomerMessages(queue, orders, slots),
      inject: [MessageQueue, Orders, Slots],
    },
    {
      provide: Reminders,
      useFactory: (queue: MessageQueue, dunning: Dunning, refs: MasterDataRefs) => new Reminders(queue, dunning, refs),
      inject: [MessageQueue, Dunning, MasterDataRefs],
    },
    {
      provide: StaffNotifications,
      useFactory: (queue: MessageQueue, mortality: MortalityRecords, units: StockUnits) => new StaffNotifications(queue, mortality, units),
      inject: [MessageQueue, MortalityRecords, StockUnits],
    },
    {
      provide: LinkMessages,
      useFactory: (queue: MessageQueue, orders: Orders, refs: MasterDataRefs) => new LinkMessages(queue, orders, refs),
      inject: [MessageQueue, Orders, MasterDataRefs],
    },
    {
      // Each link a message carries, made at send by the record's own module (ADR-0074, B11 continued 12).
      provide: MessageLinks,
      useFactory: (config: AppConfig, online: OnlineOrders, receipts: ReceiptLinks, carts: AbandonedCarts) =>
        new MessageLinks(config.RECEIPT_LINK_BASE_URL ?? null, {
          TRACKING: (tx, orderId, actorId) => online.reissueTrackingIn(tx, orderId, actorId),
          RECEIPT: (tx, saleId, actorId) => receipts.issueMessageLinkIn(tx, saleId, actorId),
          CART: (tx, cartId) => carts.remindableIn(tx, cartId),
        }),
      inject: [APP_CONFIG, OnlineOrders, ReceiptLinks, AbandonedCarts],
    },
    {
      provide: MessageSender,
      useFactory: (uow: UnitOfWork, store: NtfStore, recipients: RecipientFacts, sms: NotificationChannel, events: DomainEvents, clock: Clock, logger: Logger, links: MessageLinks) =>
        new MessageSender(uow, store, recipients, new Map([['SMS', sms]]), events, clock, logger, Math.random, links),
      inject: [UnitOfWork, NTF_STORE, RecipientFacts, SMS_CHANNEL, DomainEvents, CLOCK, LOGGER, MessageLinks],
    },
    {
      provide: OptOuts,
      useFactory: (uow: UnitOfWork, store: NtfStore, authoriser: Authoriser, hasher: AddressHasher, cursors: Cursors, clock: Clock) => new OptOuts(uow, store, authoriser, hasher, cursors, clock),
      inject: [UnitOfWork, NTF_STORE, Authoriser, AddressHasher, Cursors, CLOCK],
    },
    {
      provide: DeliveryReports,
      useFactory: (uow: UnitOfWork, store: NtfStore, events: DomainEvents, optOuts: OptOuts, config: AppConfig, clock: Clock, logger: Logger) => new DeliveryReports(uow, store, events, optOuts, config.SMS_WEBHOOK_SECRET, clock, logger),
      inject: [UnitOfWork, NTF_STORE, DomainEvents, OptOuts, APP_CONFIG, CLOCK, LOGGER],
    },
    {
      provide: Preferences,
      useFactory: (uow: UnitOfWork, store: NtfStore, refs: MasterDataRefs, idempotency: Idempotency, audit: AuditTrail, clock: Clock) => new Preferences(uow, store, refs, idempotency, audit, clock),
      inject: [UnitOfWork, NTF_STORE, MasterDataRefs, Idempotency, AuditTrail, CLOCK],
    },
    {
      provide: Triggers,
      useFactory: (uow: UnitOfWork, store: NtfStore, authoriser: Authoriser, idempotency: Idempotency, audit: AuditTrail, cursors: Cursors, clock: Clock) => new Triggers(uow, store, authoriser, idempotency, audit, cursors, clock),
      inject: [UnitOfWork, NTF_STORE, Authoriser, Idempotency, AuditTrail, Cursors, CLOCK],
    },
    {
      provide: InAppNotifications,
      useFactory: (uow: UnitOfWork, store: NtfStore, cursors: Cursors, clock: Clock) => new InAppNotifications(uow, store, cursors, clock),
      inject: [UnitOfWork, NTF_STORE, Cursors, CLOCK],
    },
  ],
  exports: [MessageSender],
})
export class NtfModule implements OnModuleInit {
  constructor(
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(CustomerMessages) private readonly customerMessages: CustomerMessages,
    @Inject(Reminders) private readonly reminders: Reminders,
    @Inject(StaffNotifications) private readonly staff: StaffNotifications,
    @Inject(LinkMessages) private readonly links: LinkMessages,
  ) {}

  onModuleInit(): void {
    this.events.registerConsumer(this.customerMessages.consumer);
    this.events.registerConsumer(this.reminders.consumer);
    this.events.registerConsumer(this.staff.consumer);
    this.events.registerConsumer(this.links.consumer);
  }
}
