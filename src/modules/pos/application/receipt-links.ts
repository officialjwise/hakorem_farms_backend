import { Money, type Clock } from '@hakorem/kernel';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { BusinessProfiles } from '../../aud';
import type { Billing } from '../../bil';
import type { MasterDataRefs } from '../../mdm';
import type { Orders } from '../../ord';
import { receiptTokenHash, receiptTokenVerdict, type ReceiptTokenVerdict } from '../domain/receipt-link';
import { changeDue, type TenderKind } from '../domain/till';
import type { ReceiptBindingRecord, ReceiptLinkStore, ReceiptTenderRecord } from './receipt-link-store';

/** One answer for every token that opens nothing: never sent, mistyped, guessed, altered, expired, revoked or an id. */
const NO_RECEIPT = 'no receipt answers this link';

/** The contract's `PublicReceipt` (CR-033 point 4, ADR-0083): the sale as recorded, with no id of anything. */
export interface PublicReceiptView {
  readonly state: 'RECORDED';
  readonly saleReference: string;
  readonly receiptNo: string;
  readonly occurredAt: string;
  readonly validUntil: string;
  readonly business: { readonly name: string; readonly phone: string; readonly address: string } | null;
  readonly lines: readonly {
    readonly name: string;
    readonly quantity: string;
    readonly saleUom: string;
    readonly weightKg: string | null;
    readonly stockUnitIdentifier: string | null;
    readonly unitPricePesewas: number;
    readonly amountPesewas: number;
  }[];
  readonly totalPesewas: number;
  readonly tenders: readonly { readonly name: string; readonly amountPesewas: number; readonly tenderedPesewas: number | null; readonly unverified: boolean }[];
  readonly changePesewas: number;
  readonly currency: 'GHS';
}

/** A till's token judged for a sale: its hash, the link it is already bound to, and what the server does with it. */
export interface ReceiptJudgement {
  readonly hash: Buffer;
  readonly bound: ReceiptBindingRecord | null;
  readonly verdict: ReceiptTokenVerdict;
}

/** A tender of the sale as the till took it, with its method's kind for the change. */
export interface TillTender {
  readonly paymentMethodId: string;
  readonly kind: TenderKind;
  readonly amountPesewas: number;
  readonly tenderedPesewas: number | null;
  readonly unverified: boolean;
}

/**
 * The receipt link (CR-033 points 1 and 2, ADR-0074 Amendments, ADR-0083). At sync the till's token is judged and bound to
 * the sale by its hash, in the sale's own transaction (`judgeIn`, `recordIn`), or refused with the sale still recorded. The public read
 * (`publicReceipt`) takes the token and nothing else and answers the sale as the server recorded it.
 */
export class ReceiptLinks {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: ReceiptLinkStore,
    private readonly orders: Orders,
    private readonly billing: Billing,
    private readonly refs: MasterDataRefs,
    private readonly profiles: BusinessProfiles,
    private readonly clock: Clock,
    private readonly nextId: () => string,
  ) {}

  /** What the server does with a till's token for this sale, read in the sale's transaction before it is logged. */
  async judgeIn(tx: Transaction, token: string, saleId: string): Promise<ReceiptJudgement> {
    const hash = receiptTokenHash(token);
    if (hash === null) throw new Error('a receipt token reaches the judgement only in its checked form');
    const bound = await this.store.bindingOfToken(tx, hash);
    return { hash, bound, verdict: receiptTokenVerdict({ token, saleId, boundTo: bound?.saleId ?? null }) };
  }

  /**
   * Records the judgement in the sale's transaction, after its `pos.sale_sync` row: the link bound to the sale by the
   * token's hash, or the refusal, once for this sale (`pos.receipt_token_refusal`, its primary key), marked as needing a
   * fresh server-made link. The caller raises a refusal to the exception report's source.
   */
  async recordIn(
    tx: Transaction,
    judged: ReceiptJudgement,
    f: { readonly saleId: string; readonly branchId: string; readonly shiftId: string; readonly deviceId: string; readonly cashierId: string; readonly occurredAt: Date; readonly tenders: readonly TillTender[]; readonly now: Date; readonly actorId: string },
  ): Promise<void> {
    const { verdict, hash } = judged;
    if (verdict.kind === 'KEEP') return;
    if (verdict.kind === 'REFUSE') {
      await this.store.insertRefusal(tx, { orderDocumentId: f.saleId, tokenHash: hash, reason: verdict.reason, boundOrderDocumentId: verdict.boundTo, branchId: f.branchId, shiftId: f.shiftId, deviceId: f.deviceId, cashierId: f.cashierId, recordedAt: f.now, actorId: f.actorId });
      return;
    }
    // The change the till gave, from its cash tenders by the counter's own rule; none when its tenders give none by it.
    const change = changeDue(f.tenders.map((t) => ({ kind: t.kind, amount: Money.fromJsonInteger(t.amountPesewas), tendered: t.tenderedPesewas === null ? null : Money.fromJsonInteger(t.tenderedPesewas) })));
    const tenders: ReceiptTenderRecord[] = f.tenders.map((t) => ({ paymentMethodId: t.paymentMethodId, amountPesewas: t.amountPesewas, tenderedPesewas: t.tenderedPesewas, unverified: t.unverified }));
    await this.store.insertLink(tx, { id: this.nextId(), orderDocumentId: f.saleId, branchId: f.branchId, shiftId: f.shiftId, deviceId: f.deviceId, tokenHash: hash, issuedAt: f.occurredAt, tenders, changePesewas: change.ok ? change.value.pesewas : 0n, recordedAt: f.now, actorId: f.actorId });
  }

  /** `getPublicReceipt`: anonymous, rate-limited, by the token alone; anything that is not a live link's token is 404. */
  async publicReceipt(token: string): Promise<PublicReceiptView> {
    const hash = receiptTokenHash(token);
    if (hash === null) throw new NotFoundError(NO_RECEIPT);
    const found = await this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const link = await this.store.liveLink(tx, hash, this.clock.now());
      if (link === null) return null;
      const order = await this.orders.viewOf(tx, link.orderDocumentId);
      const receiptId = order.billingDocument?.id ?? null;
      const [receipt] = receiptId === null ? [] : await this.billing.viewsIn(tx, [receiptId]);
      const methods = await this.refs.paymentMethodsIn(tx, link.tenders.map((t) => t.paymentMethodId));
      return { link, order, receipt, methods };
    });
    if (found === null || found.receipt === undefined || found.order.orderNo === null || found.receipt.documentNo === null) throw new NotFoundError(NO_RECEIPT);
    const { link, order, receipt, methods } = found;
    const shop = await this.profiles.shopProfile();
    return {
      state: 'RECORDED',
      saleReference: order.orderNo!,
      receiptNo: receipt.documentNo!,
      occurredAt: link.issuedAt.toISOString(),
      validUntil: link.expiresAt.toISOString(),
      business: shop === null ? null : { name: shop.tradingName, phone: shop.phone, address: shop.address },
      lines: order.lines.map((l) => ({
        name: l.product.name,
        quantity: l.qtyOrdered,
        saleUom: l.uom,
        weightKg: l.fulfilledWeightKg ?? l.estimatedWeightKg,
        stockUnitIdentifier: l.stockUnit?.identifier ?? null,
        unitPricePesewas: l.agreedUnitPricePesewas,
        amountPesewas: l.finalLineTotalPesewas ?? l.estimatedLineTotalPesewas,
      })),
      totalPesewas: receipt.grossPesewas,
      tenders: link.tenders.map((t) => ({ name: methods.get(t.paymentMethodId)?.name ?? '', amountPesewas: t.amountPesewas, tenderedPesewas: t.tenderedPesewas, unverified: t.unverified })),
      changePesewas: Money.ofPesewas(link.changePesewas).toJsonInteger(),
      currency: 'GHS',
    };
  }
}
