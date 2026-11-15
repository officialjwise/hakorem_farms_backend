import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DocumentRegistry } from '../../platform/documents/document-registry';
import { DomainEvents } from '../../platform/events/domain-events';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { CLOCK } from '../../platform/platform.module';
import { FileStore } from '../../platform/storage/file-store';
import { Approvals, Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { InvModule } from '../inv';
import { MasterDataRefs, MdmModule, TaxService } from '../mdm';
import { PURCHASE_ORDER_KIND, PurchaseOrders } from './application/purchase-orders';
import { PURCHASING_STORE, type PurchasingStore } from './application/purchasing-store';
import { SupplierInvoices } from './application/supplier-invoices';
import { SUPPLIER_PAYMENT_KIND, SupplierPayments } from './application/supplier-payments';
import { PgPurchasingStore } from './infrastructure/pg-purchasing-store';
import { PurchasingController } from './interface/purchasing.controller';

/**
 * PUR (layer 7): procurement and suppliers. B7 builds purchase to pay: purchase orders with their approval limit,
 * received quantities kept from INV's goods receipts, supplier invoices with the three-way match, and supplier payments
 * approved by a different person. Master data and tax come from MDM, approvals from IAM; stock is INV's alone.
 */
@Module({
  imports: [IamModule, MdmModule, InvModule],
  controllers: [PurchasingController],
  providers: [
    { provide: PURCHASING_STORE, useClass: PgPurchasingStore },
    {
      provide: PurchaseOrders,
      useFactory: (
        uow: UnitOfWork,
        store: PurchasingStore,
        refs: MasterDataRefs,
        tax: TaxService,
        approvals: Approvals,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        documents: DocumentRegistry,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new PurchaseOrders(uow, store, refs, tax, approvals, authoriser, idempotency, audit, events, documents, principals, cursors, clock),
      inject: [UnitOfWork, PURCHASING_STORE, MasterDataRefs, TaxService, Approvals, Authoriser, Idempotency, AuditTrail, DomainEvents, DocumentRegistry, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: SupplierInvoices,
      useFactory: (
        uow: UnitOfWork,
        store: PurchasingStore,
        refs: MasterDataRefs,
        tax: TaxService,
        files: FileStore,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        documents: DocumentRegistry,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new SupplierInvoices(uow, store, refs, tax, files, authoriser, idempotency, audit, events, documents, principals, cursors, clock),
      inject: [UnitOfWork, PURCHASING_STORE, MasterDataRefs, TaxService, FileStore, Authoriser, Idempotency, AuditTrail, DomainEvents, DocumentRegistry, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: SupplierPayments,
      useFactory: (
        uow: UnitOfWork,
        store: PurchasingStore,
        refs: MasterDataRefs,
        approvals: Approvals,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        documents: DocumentRegistry,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new SupplierPayments(uow, store, refs, approvals, authoriser, idempotency, audit, events, documents, principals, cursors, clock),
      inject: [UnitOfWork, PURCHASING_STORE, MasterDataRefs, Approvals, Authoriser, Idempotency, AuditTrail, DomainEvents, DocumentRegistry, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
  ],
  exports: [PurchaseOrders, SupplierInvoices, SupplierPayments],
})
export class PurModule implements OnModuleInit {
  constructor(
    @Inject(Approvals) private readonly approvals: Approvals,
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(PurchaseOrders) private readonly orders: PurchaseOrders,
    @Inject(SupplierPayments) private readonly payments: SupplierPayments,
  ) {}

  /**
   * Registers PUR's approval handlers (ADR-0017), a purchase order above the limit and every supplier payment, and the
   * transactional subscriber that keeps an order line's received quantity in the goods receipt's transaction (A-164).
   */
  onModuleInit(): void {
    this.approvals.registerHandler(PURCHASE_ORDER_KIND, this.orders);
    this.approvals.registerHandler(SUPPLIER_PAYMENT_KIND, this.payments);
    this.events.subscribeInTransaction('inv.GoodsReceiptPosted', this.orders.received);
  }
}
