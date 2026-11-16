import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DocumentRegistry } from '../../platform/documents/document-registry';
import { DomainEvents } from '../../platform/events/domain-events';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { SubjectKeys } from '../../platform/crypto/subject-keys';
import { CLOCK } from '../../platform/platform.module';
import { Settings } from '../../platform/settings/settings';
import { FileStore } from '../../platform/storage/file-store';
import { BankAccounts, FinModule } from '../fin';
import { Approvals, Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { InvModule, Stock } from '../inv';
import { MasterDataRefs, MdmModule, TaxService } from '../mdm';
import { PURCHASE_ORDER_KIND, PurchaseOrders } from './application/purchase-orders';
import { PURCHASING_STORE, type PurchasingStore } from './application/purchasing-store';
import { Requisitions } from './application/requisitions';
import { PUR_LEDGER_EVENTS, SUPPLIER_CREDIT_NOTE_KIND, SUPPLIER_INVOICE_VARIANCE_KIND, SupplierInvoices } from './application/supplier-invoices';
import { SUPPLIER_PAYMENT_KIND, SupplierPayments } from './application/supplier-payments';
import { SupplierScores } from './application/supplier-scores';
import { SUPPLIER_REGISTER_STORE, type SupplierRegisterStore } from './application/supplier-register-store';
import { SUPPLIER_PAYOUT_CHANGE_KIND, Suppliers } from './application/suppliers';
import { PgPurchasingStore } from './infrastructure/pg-purchasing-store';
import { PgSupplierRegisterStore } from './infrastructure/pg-supplier-register-store';
import { PurchasingController } from './interface/purchasing.controller';
import { SupplierRegisterController } from './interface/supplier-register.controller';

/**
 * PUR (layer 7): procurement and suppliers. B7 builds purchase to pay: purchase orders with their approval limit,
 * received quantities kept from INV's goods receipts, supplier invoices with the three-way match, and supplier payments
 * approved by a different person. B07 continued adds the supplier register (terms, payout details changed only by a
 * different person's approval, documents) and requisitions converted into purchase orders. Master data and tax come from MDM, approvals from IAM; stock is INV's alone.
 */
@Module({
  imports: [IamModule, MdmModule, FinModule, InvModule],
  controllers: [PurchasingController, SupplierRegisterController],
  providers: [
    { provide: PURCHASING_STORE, useClass: PgPurchasingStore },
    { provide: SUPPLIER_REGISTER_STORE, useClass: PgSupplierRegisterStore },
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
        settings: Settings,
      ) => new PurchaseOrders(uow, store, refs, tax, approvals, authoriser, idempotency, audit, events, documents, principals, cursors, clock, settings),
      inject: [UnitOfWork, PURCHASING_STORE, MasterDataRefs, TaxService, Approvals, Authoriser, Idempotency, AuditTrail, DomainEvents, DocumentRegistry, PRINCIPAL_NAMES, Cursors, CLOCK, Settings],
    },
    {
      provide: SupplierInvoices,
      useFactory: (
        uow: UnitOfWork,
        store: PurchasingStore,
        register: SupplierRegisterStore,
        refs: MasterDataRefs,
        tax: TaxService,
        files: FileStore,
        approvals: Approvals,
        stock: Stock,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        documents: DocumentRegistry,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new SupplierInvoices(uow, store, register, refs, tax, files, approvals, stock, authoriser, idempotency, audit, events, documents, principals, cursors, clock),
      inject: [UnitOfWork, PURCHASING_STORE, SUPPLIER_REGISTER_STORE, MasterDataRefs, TaxService, FileStore, Approvals, Stock, Authoriser, Idempotency, AuditTrail, DomainEvents, DocumentRegistry, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: SupplierScores,
      useFactory: (uow: UnitOfWork, store: PurchasingStore, refs: MasterDataRefs, authoriser: Authoriser, settings: Settings, cursors: Cursors, clock: Clock) =>
        new SupplierScores(uow, store, refs, authoriser, settings, cursors, clock),
      inject: [UnitOfWork, PURCHASING_STORE, MasterDataRefs, Authoriser, Settings, Cursors, CLOCK],
    },
    {
      provide: SupplierPayments,
      useFactory: (
        uow: UnitOfWork,
        store: PurchasingStore,
        register: SupplierRegisterStore,
        refs: MasterDataRefs,
        approvals: Approvals,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        documents: DocumentRegistry,
        principals: PrincipalNames,
        bankAccounts: BankAccounts,
        cursors: Cursors,
        clock: Clock,
      ) => new SupplierPayments(uow, store, register, refs, approvals, authoriser, idempotency, audit, events, documents, principals, bankAccounts, cursors, clock),
      inject: [UnitOfWork, PURCHASING_STORE, SUPPLIER_REGISTER_STORE, MasterDataRefs, Approvals, Authoriser, Idempotency, AuditTrail, DomainEvents, DocumentRegistry, PRINCIPAL_NAMES, BankAccounts, Cursors, CLOCK],
    },
    {
      provide: Suppliers,
      useFactory: (
        uow: UnitOfWork,
        store: SupplierRegisterStore,
        refs: MasterDataRefs,
        approvals: Approvals,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        documents: DocumentRegistry,
        subjectKeys: SubjectKeys,
        files: FileStore,
        cursors: Cursors,
        clock: Clock,
      ) => new Suppliers(uow, store, refs, approvals, authoriser, idempotency, audit, events, documents, subjectKeys, files, cursors, clock),
      inject: [UnitOfWork, SUPPLIER_REGISTER_STORE, MasterDataRefs, Approvals, Authoriser, Idempotency, AuditTrail, DomainEvents, DocumentRegistry, SubjectKeys, FileStore, Cursors, CLOCK],
    },
    {
      provide: Requisitions,
      useFactory: (
        uow: UnitOfWork,
        store: SupplierRegisterStore,
        orders: PurchaseOrders,
        refs: MasterDataRefs,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        documents: DocumentRegistry,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new Requisitions(uow, store, orders, refs, authoriser, idempotency, audit, events, documents, principals, cursors, clock),
      inject: [UnitOfWork, SUPPLIER_REGISTER_STORE, PurchaseOrders, MasterDataRefs, Authoriser, Idempotency, AuditTrail, DomainEvents, DocumentRegistry, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
  ],
  exports: [PurchaseOrders, SupplierInvoices, SupplierPayments, SupplierScores, Suppliers, Requisitions],
})
export class PurModule implements OnModuleInit {
  constructor(
    @Inject(Approvals) private readonly approvals: Approvals,
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(PurchaseOrders) private readonly orders: PurchaseOrders,
    @Inject(SupplierInvoices) private readonly invoices: SupplierInvoices,
    @Inject(SupplierPayments) private readonly payments: SupplierPayments,
    @Inject(Suppliers) private readonly suppliers: Suppliers,
  ) {}

  /**
   * Registers PUR's approval handlers (ADR-0017), a purchase order above the limit, every supplier payment, every
   * payout detail change, every supplier credit note and every invoice variance (A-172), and the transactional subscribers that keep an order line's received quantity in the goods
   * receipt's transaction (A-164) and open each new supplier's profile in its registration's transaction (A-166).
   */
  onModuleInit(): void {
    this.approvals.registerHandler(PURCHASE_ORDER_KIND, this.orders);
    this.approvals.registerHandler(SUPPLIER_PAYMENT_KIND, this.payments);
    this.approvals.registerHandler(SUPPLIER_PAYOUT_CHANGE_KIND, this.suppliers);
    this.approvals.registerHandler(SUPPLIER_CREDIT_NOTE_KIND, this.invoices.creditNoteApprovals);
    this.approvals.registerHandler(SUPPLIER_INVOICE_VARIANCE_KIND, this.invoices.varianceApprovals);
    this.events.subscribeInTransaction('inv.GoodsReceiptPosted', this.orders.received);
    this.events.subscribeInTransaction('mdm.SupplierRegistered', this.suppliers.registered);
    this.events.declareLedgerEvents(PUR_LEDGER_EVENTS);
  }
}
