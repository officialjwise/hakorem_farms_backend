import { Module } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { DocumentRegistry } from '../../platform/documents/document-registry';
import { NumberSeries } from '../../platform/documents/number-series';
import { DomainEvents } from '../../platform/events/domain-events';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { CLOCK } from '../../platform/platform.module';
import { BilModule, Billing } from '../bil';
import { InvModule, Reservations, Stock, StockUnits } from '../inv';
import { MasterDataRefs, MdmModule, PricingService } from '../mdm';
import { PayModule, Payments } from '../pay';
import { ORDER_STORE, type OrderStore } from './application/order-store';
import { SalePosting } from './application/sale-posting';
import { PgOrderStore } from './infrastructure/pg-order-store';

/**
 * ORD (layer 9): the one order record of every channel and the sale posting that issues stock, the billing document
 * and the tenders in one serializable transaction (B9a). The order endpoints, returns, voids and online placement
 * follow in B09a continued (A-209); POS's counter sale (B9b) and fulfilment's dispatch (B11) call `SalePosting.postIn`.
 */
@Module({
  imports: [MdmModule, InvModule, BilModule, PayModule],
  providers: [
    { provide: ORDER_STORE, useClass: PgOrderStore },
    {
      provide: SalePosting,
      useFactory: (
        store: OrderStore,
        refs: MasterDataRefs,
        pricing: PricingService,
        stock: Stock,
        units: StockUnits,
        reservations: Reservations,
        billing: Billing,
        payments: Payments,
        numbers: NumberSeries,
        documents: DocumentRegistry,
        events: DomainEvents,
        idempotency: Idempotency,
        audit: AuditTrail,
        clock: Clock,
      ) => new SalePosting(store, refs, pricing, stock, units, reservations, billing, payments, numbers, documents, events, idempotency, audit, clock),
      inject: [ORDER_STORE, MasterDataRefs, PricingService, Stock, StockUnits, Reservations, Billing, Payments, NumberSeries, DocumentRegistry, DomainEvents, Idempotency, AuditTrail, CLOCK],
    },
  ],
  exports: [SalePosting],
})
export class OrdModule {}
