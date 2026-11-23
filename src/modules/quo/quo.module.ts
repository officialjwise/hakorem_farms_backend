import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Clock } from '@hakorem/kernel';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DocumentRegistry } from '../../platform/documents/document-registry';
import { NumberSeries } from '../../platform/documents/number-series';
import { DomainEvents } from '../../platform/events/domain-events';
import { Cursors } from '../../platform/http/cursor';
import { RateLimiter } from '../../platform/http/rate-limiter';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { CLOCK } from '../../platform/platform.module';
import { Settings } from '../../platform/settings/settings';
import { Approvals, Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { InvModule, Reservations, StockQueries, StockUnits } from '../inv';
import { MasterDataRefs, MdmModule, PartiesAdmin, PricingService, TaxService } from '../mdm';
import { OrdModule, Orders } from '../ord';
import { QUOTE_STORE, type QuoteStore } from './application/quote-store';
import { QUOTE_BELOW_MARGIN_KIND, QuoteExpiry, Quotes } from './application/quotes';
import { Rfqs } from './application/rfqs';
import { IamStaffSessions } from './infrastructure/iam-staff-sessions';
import { PgQuoteStore } from './infrastructure/pg-quote-store';
import { QuoteLinksController } from './interface/quote-links.controller';
import { MyQuotesController, QuotesController, RfqsController } from './interface/quotes.controller';

/**
 * QUO (layer 10): requests for quote and quotes made of immutable versions (B10). It calls down to MDM (pricing, tax,
 * units, parties), INV (costs and reservations), ORD (the converted order) and IAM (authorisation and the
 * QUOTE_BELOW_MARGIN approval, whose handler it registers). No module imports QUO.
 */
@Module({
  imports: [IamModule, MdmModule, InvModule, OrdModule],
  controllers: [RfqsController, QuotesController, MyQuotesController, QuoteLinksController],
  providers: [
    { provide: QUOTE_STORE, useClass: PgQuoteStore },
    {
      provide: Quotes,
      useFactory: (
        uow: UnitOfWork,
        store: QuoteStore,
        refs: MasterDataRefs,
        pricing: PricingService,
        tax: TaxService,
        units: StockUnits,
        stock: StockQueries,
        reservations: Reservations,
        orders: Orders,
        approvals: Approvals,
        authoriser: Authoriser,
        principals: PrincipalNames,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        registry: DocumentRegistry,
        numbers: NumberSeries,
        settings: Settings,
        cursors: Cursors,
        clock: Clock,
        modules: ModuleRef,
      ) => new Quotes(uow, store, refs, pricing, tax, units, stock, reservations, orders, approvals, authoriser, principals, idempotency, audit, events, registry, numbers, settings, cursors, clock, new IamStaffSessions(modules)),
      inject: [UnitOfWork, QUOTE_STORE, MasterDataRefs, PricingService, TaxService, StockUnits, StockQueries, Reservations, Orders, Approvals, Authoriser, PRINCIPAL_NAMES, Idempotency, AuditTrail, DomainEvents, DocumentRegistry, NumberSeries, Settings, Cursors, CLOCK, ModuleRef],
    },
    {
      provide: Rfqs,
      useFactory: (
        uow: UnitOfWork,
        store: QuoteStore,
        refs: MasterDataRefs,
        parties: PartiesAdmin,
        units: StockUnits,
        authoriser: Authoriser,
        principals: PrincipalNames,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        registry: DocumentRegistry,
        numbers: NumberSeries,
        limiter: RateLimiter,
        settings: Settings,
        cursors: Cursors,
        clock: Clock,
        config: AppConfig,
      ) => new Rfqs(uow, store, refs, parties, units, authoriser, principals, idempotency, audit, events, registry, numbers, limiter, settings, cursors, clock, Buffer.from(config.LOOKUP_HMAC_KEY, 'base64')),
      inject: [UnitOfWork, QUOTE_STORE, MasterDataRefs, PartiesAdmin, StockUnits, Authoriser, PRINCIPAL_NAMES, Idempotency, AuditTrail, DomainEvents, DocumentRegistry, NumberSeries, RateLimiter, Settings, Cursors, CLOCK, APP_CONFIG],
    },
    { provide: QuoteExpiry, useFactory: (quotes: Quotes) => new QuoteExpiry(quotes), inject: [Quotes] },
  ],
  exports: [Quotes, Rfqs, QuoteExpiry],
})
export class QuoModule implements OnModuleInit {
  constructor(
    @Inject(Approvals) private readonly approvals: Approvals,
    @Inject(Quotes) private readonly quotes: Quotes,
  ) {}

  onModuleInit(): void {
    this.approvals.registerHandler(QUOTE_BELOW_MARGIN_KIND, this.quotes.approvalHandler);
  }
}
