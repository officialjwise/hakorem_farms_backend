import { createUuidV7Generator, Money, type Clock } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import { databaseErrorOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../../../platform/errors/api-error';
import type { Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { judgeRedemption } from '../domain/receipt';
import { jsonPesewas as json } from '../domain/tender';
import { PaymentInvalidError, StoreCreditInsufficientError } from './errors';
import type { PaymentStore, StoreCreditEntryRecord } from './payment-store';

const READ = 'pay.store_credit.read';
/** How many of a customer's latest entries the balance is shown with. */
const ENTRIES_SHOWN = 100;

/** The contract's `StoreCredit`. */
export interface StoreCreditView {
  readonly customer: { readonly id: string; readonly customerNo: string; readonly name: string };
  readonly balancePesewas: number;
  readonly currency: 'GHS';
  readonly entries: readonly {
    readonly id: string;
    readonly direction: StoreCreditEntryRecord['direction'];
    readonly amountPesewas: number;
    readonly sourceDocument: { readonly id: string; readonly docType: string; readonly number: string | null };
    readonly recordedAt: string;
  }[];
}

/**
 * Store credit (FR-PAY-015): a ledger of entries per customer held in 2210, its balance a projection the database keeps
 * and never lets go below zero (`ck_store_credit_balance`, under the balance row's lock, so two redemptions of the last
 * credit cannot both succeed). Credit is issued by a refund to store credit and by the reversal of a redemption; it is
 * redeemed as a tender (`recordPayment` with a store credit method). The entries are written in the transaction of the
 * document that causes them, whose ◆ event posts 2210.
 */
export class StoreCredit {
  private readonly nextId: () => string;

  constructor(
    private readonly store: PaymentStore,
    private readonly refs: MasterDataRefs,
    private readonly documents: DocumentRegistry,
    private readonly uow: UnitOfWork,
    private readonly authoriser: Authoriser,
    clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** Credit issued to a customer by a document (a refund, or the payment reversing a redemption), once per document. */
  async issueIn(tx: Transaction, actorId: string, e: { readonly customerId: string; readonly amountPesewas: bigint; readonly sourceDocumentId: string; readonly branchId: string }): Promise<void> {
    // Never the walk-in, and only a named customer with a phone number (the owner, 2026-11-16); the database holds it too.
    if ((await this.refs.customersIn(tx, [e.customerId])).get(e.customerId)?.hasPhone !== true) throw new PaymentInvalidError([{ field: '/customerId', rule: 'STORE_CREDIT_NEEDS_PHONE' }]);
    await this.store.insertStoreCredit(tx, { id: this.nextId(), direction: 'ISSUE', actorId, ...e });
  }

  /** Credit redeemed by a payment: refused beyond the balance, by the rule and by the database. */
  async redeemIn(tx: Transaction, actorId: string, e: { readonly customerId: string; readonly amountPesewas: bigint; readonly sourceDocumentId: string; readonly branchId: string }, field = '/amountPesewas'): Promise<void> {
    const balance = await this.store.storeCreditBalance(tx, e.customerId);
    if (!judgeRedemption(Money.ofPesewas(balance), Money.ofPesewas(e.amountPesewas)).ok) throw new StoreCreditInsufficientError(field, balance);
    try {
      await this.store.insertStoreCredit(tx, { id: this.nextId(), direction: 'REDEEM', actorId, ...e });
    } catch (error) {
      const failure = databaseErrorOf(error);
      if (failure?.code === 'HK010' && failure.constraint === 'ck_store_credit_balance') throw new StoreCreditInsufficientError(field, await this.store.storeCreditBalance(tx, e.customerId));
      throw error;
    }
  }

  /** `getCustomerStoreCredit`: a customer's balance and latest entries, for staff holding `pay.store_credit.read`. */
  forCustomer(actor: Actor | undefined, customerId: string): Promise<StoreCreditView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const customer = (await this.refs.customersIn(tx, [customerId])).get(customerId);
      if (customer === undefined) throw new NotFoundError('no such customer');
      return this.viewIn(tx, customer);
    });
  }

  /** `getMyStoreCredit`: a signed-in customer's own balance; nobody else's, and only in the customer realm. */
  mine(actor: Actor | undefined): Promise<StoreCreditView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      if (actor === undefined) throw new UnauthenticatedError('sign in to see your store credit');
      if (actor.realm !== 'CUSTOMER') throw new ForbiddenError('store credit is read here by the customer it belongs to');
      const customer = await this.refs.customerOfPrincipalIn(tx, actor.principalId);
      if (customer === null) throw new NotFoundError('no customer account is linked to this sign-in');
      return this.viewIn(tx, customer);
    });
  }

  private async viewIn(tx: Transaction, customer: { readonly id: string; readonly customerNo: string; readonly name: string }): Promise<StoreCreditView> {
    const balance = await this.store.storeCreditBalance(tx, customer.id);
    const entries = await this.store.storeCreditEntries(tx, customer.id, ENTRIES_SHOWN);
    const sources = await this.documents.numberedRefs(tx, entries.map((e) => e.sourceDocumentId));
    return {
      customer: { id: customer.id, customerNo: customer.customerNo, name: customer.name },
      balancePesewas: json(balance),
      currency: 'GHS',
      entries: entries.map((e) => ({
        id: e.id,
        direction: e.direction,
        amountPesewas: json(e.amountPesewas),
        sourceDocument: sources.get(e.sourceDocumentId) ?? { id: e.sourceDocumentId, docType: 'PAYMENT', number: null },
        recordedAt: e.recordedAt.toISOString(),
      })),
    };
  }
}
