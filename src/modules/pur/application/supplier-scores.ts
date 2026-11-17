import { Quantity, type Clock } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { UnitOfWork } from '../../../platform/database/unit-of-work';
import type { Cursors } from '../../../platform/http/cursor';
import type { Settings } from '../../../platform/settings/settings';
import type { Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import {
  combineScore,
  onTimeComponent,
  percentText,
  priceComponent,
  priceVariance,
  qualityComponent,
  rejectedAtReceipt,
  rejectionComponent,
  type Percentage,
  type PriceFacts,
  type ScoreWeights,
} from '../domain/supplier-score';
import { readPage, supplierRef, type Page } from './purchase-command';
import type { PurchasingStore, ScoreFacts } from './purchasing-store';

const READ = 'pur.supplier.read';

/** The weight settings (FR-PUR-014): whole numbers, farm-wide, changed through AUD's `updateSetting` (A-173). */
export const SCORE_WEIGHT_SETTINGS = {
  price: { key: 'pur.supplier_score.price_weight', fallback: 30 },
  leadTime: { key: 'pur.supplier_score.lead_time_weight', fallback: 25 },
  quality: { key: 'pur.supplier_score.quality_weight', fallback: 25 },
  rejection: { key: 'pur.supplier_score.rejection_weight', fallback: 20 },
} as const;

/** The contract's `SupplierScore`, with the four components it is weighed from (1.30.0). */
export interface SupplierScoreView {
  readonly supplier: { readonly id: string; readonly publicId: string; readonly name: string };
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly ordersCount: number;
  readonly onTimePercent: string | null;
  readonly rejectionPercent: string | null;
  readonly priceVariancePercent: string | null;
  readonly returnedPercent: string | null;
  readonly components: { readonly price: string | null; readonly leadTime: string | null; readonly quality: string | null; readonly rejection: string | null };
  readonly weights: { readonly price: number; readonly leadTime: number; readonly quality: number; readonly rejection: number };
  readonly score: string | null;
}

interface Computed {
  readonly id: string;
  readonly view: Omit<SupplierScoreView, 'supplier'>;
}

/** The last day of the month that starts on `periodStart` (a first of the month). */
export function monthEnd(periodStart: string): string {
  const [year, month] = periodStart.split('-').map((part) => Number.parseInt(part, 10)) as [number, number];
  const last = new Date(Date.UTC(year, month, 0));
  return last.toISOString().slice(0, 10);
}

const text = (value: Percentage | null) => (value === null ? null : percentText(value));
const thousandths = (qty: string) => Quantity.parse(qty).thousandths;

/**
 * Supplier scores (FR-PUR-014, A-173), computed when asked from PUR's own facts for one calendar month: the receipt
 * lines INV told PUR about (accepted, rejected, arrived against promised), approved invoice lines (price against the
 * farm's average for each product) and goods sent back on approved credit notes. Suppliers are farm-wide (A-166), so
 * any grant of `pur.supplier.read` reads every supplier's score. Listed by supplier, newest supplier first.
 */
export class SupplierScores {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: PurchasingStore,
    private readonly refs: MasterDataRefs,
    private readonly authoriser: Authoriser,
    private readonly settings: Settings,
    readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {}

  list(actor: Actor | undefined, periodStart: string, supplierId: string | undefined, cursor: string | undefined, limit: number): Promise<Page<SupplierScoreView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) =>
      readPage<Computed, SupplierScoreView>(
        tx,
        { authoriser: this.authoriser, cursors: this.cursors },
        actor,
        READ,
        'listSupplierScores',
        { periodStart, supplierId: supplierId ?? null },
        cursor,
        limit,
        async (_scopes, before, n) => {
          const periodEnd = monthEnd(periodStart);
          const weights = await this.weights();
          const computed = scoresOf(await this.store.scoreFacts(tx, periodStart, periodEnd), periodStart, periodEnd, weights);
          return computed
            .filter((c) => (supplierId === undefined || c.id === supplierId) && (before === null || c.id < before))
            .sort((a, b) => (a.id < b.id ? 1 : -1))
            .slice(0, n);
        },
        async (records) => {
          const suppliers = await this.refs.suppliersIn(tx, records.map((r) => r.id));
          return records.map((r) => ({ supplier: supplierRef(suppliers.get(r.id)!), ...r.view }));
        },
      ),
    );
  }

  private async weights(): Promise<ScoreWeights & { readonly numbers: SupplierScoreView['weights'] }> {
    const now = this.clock.now();
    const read = async (setting: { readonly key: string; readonly fallback: number }) => this.settings.integerAt(setting.key, setting.fallback, now);
    const numbers = {
      price: await read(SCORE_WEIGHT_SETTINGS.price),
      leadTime: await read(SCORE_WEIGHT_SETTINGS.leadTime),
      quality: await read(SCORE_WEIGHT_SETTINGS.quality),
      rejection: await read(SCORE_WEIGHT_SETTINGS.rejection),
    };
    return { price: BigInt(numbers.price), leadTime: BigInt(numbers.leadTime), quality: BigInt(numbers.quality), rejection: BigInt(numbers.rejection), numbers };
  }
}

/** Every supplier with any fact in the period, scored. Pure over the facts. */
export function scoresOf(facts: ScoreFacts, periodStart: string, periodEnd: string, weights: ScoreWeights & { readonly numbers: SupplierScoreView['weights'] }): Computed[] {
  const suppliers = new Set([...facts.receipts.map((r) => r.supplierId), ...facts.priced.map((p) => p.supplierId), ...facts.returned.map((r) => r.supplierId)]);
  const allByProduct = new Map<string, { net: bigint; qty: bigint }>();
  for (const p of facts.priced) {
    const sum = allByProduct.get(p.productId) ?? { net: 0n, qty: 0n };
    allByProduct.set(p.productId, { net: sum.net + p.netPesewas, qty: sum.qty + thousandths(p.qtyBase) });
  }
  return [...suppliers].map((id) => {
    const receipts = facts.receipts.filter((r) => r.supplierId === id);
    const accepted = receipts.reduce((sum, r) => sum + thousandths(r.qtyAccepted), 0n);
    const rejected = receipts.reduce((sum, r) => sum + thousandths(r.qtyRejected), 0n);
    const returned = facts.returned.filter((r) => r.supplierId === id).reduce((sum, r) => sum + thousandths(r.qtyBase), 0n);
    const priced: PriceFacts[] = facts.priced
      .filter((p) => p.supplierId === id)
      .map((p) => {
        const all = allByProduct.get(p.productId)!;
        return { supplierNetPesewas: p.netPesewas, supplierQtyThousandths: thousandths(p.qtyBase), allNetPesewas: all.net, allQtyThousandths: all.qty };
      });
    const components = {
      price: priceComponent(priced),
      leadTime: onTimeComponent(receipts),
      quality: qualityComponent(accepted, rejected),
      rejection: rejectionComponent(returned, accepted),
    };
    const returnedShare = components.rejection === null ? null : { numerator: 100n * components.rejection.denominator - components.rejection.numerator, denominator: components.rejection.denominator };
    return {
      id,
      view: {
        periodStart,
        periodEnd,
        ordersCount: new Set(receipts.flatMap((r) => (r.purchaseOrderId === null ? [] : [r.purchaseOrderId]))).size,
        onTimePercent: text(components.leadTime),
        rejectionPercent: text(rejectedAtReceipt(accepted, rejected)),
        priceVariancePercent: text(priceVariance(priced)),
        returnedPercent: text(returnedShare),
        components: { price: text(components.price), leadTime: text(components.leadTime), quality: text(components.quality), rejection: text(components.rejection) },
        weights: weights.numbers,
        score: text(combineScore(components, weights)),
      },
    };
  });
}
