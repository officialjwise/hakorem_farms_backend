import { Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { Settings } from '../../../platform/settings/settings';
import type { Authoriser } from '../../iam';
import type { StockQueries, StockUnits } from '../../inv';
import type { Weighing } from '../../liv';
import type { MasterDataRefs, PricingService, SellingUnitView, TaxCellView, TaxService } from '../../mdm';
import { animalPrice, OFFLINE_PACK_PRICE, type AnimalPrice } from '../domain/animal-price';
import { packValidUntil } from '../domain/client-time';
import { REASONS_BY_KIND } from '../domain/till';
import type { Devices } from './devices';
import { PIN_MAX_WRONG_TRIES } from '../domain/till-pin';
import type { TillStore } from './till-store';

const SELL = 'pos.sale.create';
/** OFFLINE_SYNC 5.2: the settings the policy is read from, with their documented defaults. */
export const OFFLINE_MAX_HOURS = { key: 'pos.offline.max_hours', fallback: 8 } as const;
export const OFFLINE_MAX_QUEUED_SALES = { key: 'pos.offline.max_queued_sales', fallback: 500 } as const;
export const OFFLINE_UNVERIFIED_MOBILE_MONEY = { key: 'pos.offline.allow_unverified_mobile_money', fallback: false } as const;
/** The reasons a till takes offline: a price agreed below list, and the cash movements its kinds take (A-273 (c)). */
const OVERRIDE_DOMAIN = 'PRICE_OVERRIDE';
const CASH_DOMAIN = 'CASH_MOVEMENT';
const CASH_REASONS: ReadonlySet<string> = new Set(Object.values(REASONS_BY_KIND).flat());

/** The contract's `PriceBand`. */
interface PriceBandView {
  readonly listPricePesewas: number;
  readonly floorPricePesewas: number;
  readonly ceilingPricePesewas: number;
  readonly basis: string;
}

/** The contract's `OfflineSellingUnit` (CR-038). */
export interface OfflineSellingUnitView {
  readonly uom: string;
  readonly priceListEntryId: string | null;
  readonly priceBand: PriceBandView | null;
  readonly quoteOnly: boolean;
}

/** The contract's `OfflineProduct`. */
export interface OfflineProductView {
  readonly product: { readonly id: string; readonly sku: string; readonly name: string };
  readonly saleUom: string;
  readonly taxCategoryId: string;
  readonly priceBasis: string;
  readonly priceBand: PriceBandView | null;
  readonly priceListEntryId: string | null;
  readonly quoteOnly: boolean;
  readonly taxInclusive: boolean;
  readonly tileCategory: string | null;
  readonly sellingUnits: readonly OfflineSellingUnitView[];
}

/**
 * The contract's `OfflineStockUnit`: never a cost. An animal carries its own price, resolved by the engine from its own
 * grade and latest weight (CR-052, A-286), with the weight's date and source; a lot sells at its product's band.
 */
export interface OfflineStockUnitView extends AnimalPrice {
  readonly id: string;
  readonly identifier: string;
  readonly productId: string;
  readonly locationId: string;
  readonly gradeId: string | null;
  readonly lastWeightKg: string | null;
  readonly lastWeighedAt: string | null;
  readonly lastWeightSource: 'SCALE' | 'MANUAL' | 'ESTIMATE' | null;
  readonly sellable: boolean;
}

/** The contract's `OfflinePack`. */
export interface OfflinePackView {
  readonly register: { readonly id: string; readonly code: string; readonly name: string };
  /** The sequence the till's next shift takes, which a shift opened offline prints in its references (OFFLINE_SYNC 10, A-279 (c)). */
  readonly nextShiftSeq: number;
  /** The receipt link the till fills with each sale's own token (CR-033 point 1, ADR-0083); null while the shop's address is unset. */
  readonly receiptLinkTemplate: string | null;
  readonly generatedAt: string;
  readonly validUntil: string;
  readonly priceListVersionIds: readonly string[];
  readonly taxSchemeVersionId: string;
  readonly taxCells: readonly TaxCellView[];
  readonly products: readonly OfflineProductView[];
  readonly stockUnits: readonly OfflineStockUnitView[];
  readonly paymentMethods: readonly { readonly id: string; readonly code: string; readonly name: string; readonly kind: string }[];
  readonly reasonCodes: readonly { readonly code: string; readonly domain: string; readonly description: string; readonly requiresNote: boolean; readonly lossAccountGroup: string | null }[];
  /** The units the pack's products are sold or counted in, with the names the till says (CR-051). */
  readonly uoms: readonly { readonly code: string; readonly name: string; readonly singularName: string; readonly pluralName: string; readonly displayDecimals: number }[];
  readonly policy: {
    readonly maxOfflineHours: number;
    readonly maxQueuedSales: number;
    readonly offlineTenderMethodIds: readonly string[];
    readonly priceOverrideLimitPerLinePesewas: number;
    readonly priceOverrideLimitPerShiftPesewas: number;
    /** Wrong till PIN tries before the PIN locks until its owner sets a new one (CR-032 point 3, ADR-0080). */
    readonly pinMaxWrongTries: number;
  };
  readonly currency: 'GHS';
}

/**
 * `getOfflinePack` (FR-POS-010, OFFLINE_SYNC 5.1, B09b continued 2, A-277): everything a till needs to sell for a shift
 * with no network, a cache with an age the server never trusts at sync. Read by a holder of `pos.sale.create` at the
 * till's branch and location from an enrolled device of that till that is not revoked. It carries the channel POS
 * prices of every product a counter may sell, each unit priced by its own entry (CR-038), whether its list includes tax
 * (CR-031), the tax cells in force today, the animals and lots standing at the till, the payment methods, the price
 * override and cash movement reasons (CR-032 point 6), and the policy read from the settings of OFFLINE_SYNC 5.2 and
 * the caller's role limits. It is valid for `pos.offline.max_hours`. Each issue is audited with the device and the
 * versions it gave, so the server can tell what a synced sale was priced from. No cost reaches the device.
 */
export class OfflinePacks {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: TillStore,
    private readonly devices: Devices,
    private readonly pricing: PricingService,
    private readonly tax: TaxService,
    private readonly refs: MasterDataRefs,
    private readonly stock: StockQueries,
    private readonly units: StockUnits,
    private readonly authoriser: Authoriser,
    private readonly settings: Settings,
    private readonly audit: AuditTrail,
    private readonly clock: Clock,
    private readonly weighing: Pick<Weighing, 'latestIn'>,
    private readonly linkTemplate: string | null = null,
  ) {}

  get(actor: Actor | undefined, registerId: string, deviceCredential: string | undefined): Promise<OfflinePackView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const [register] = await this.store.registers(tx, [registerId]);
      await this.authoriser.authorise(tx, actor, SELL, register === undefined ? {} : { branchId: register.branchId, locationId: register.locationId });
      if (register === undefined) throw new NotFoundError(`no register ${registerId}`);
      const device = await this.devices.deviceOfIn(tx, deviceCredential, register.id);
      const now = this.clock.now();
      const branchId = register.branchId;
      const [maxHours, maxQueued, unverifiedMobileMoney] = await Promise.all([
        this.settings.integer(OFFLINE_MAX_HOURS.key, OFFLINE_MAX_HOURS.fallback, branchId),
        this.settings.integer(OFFLINE_MAX_QUEUED_SALES.key, OFFLINE_MAX_QUEUED_SALES.fallback, branchId),
        this.settings.boolean(OFFLINE_UNVERIFIED_MOBILE_MONEY.key, OFFLINE_UNVERIFIED_MOBILE_MONEY.fallback, branchId),
      ]);
      const selling = await this.pricing.sellingUnitsIn(tx, { channel: 'POS', branchId, at: now });
      const scheme = await this.tax.schemeInForceIn(tx, toBusinessDate(now));
      const standing = await this.stock.unitsStandingAtIn(tx, branchId, register.locationId);
      const facts = await this.units.factsIn(tx, standing.map((u) => u.stockUnitId), now);
      const methods = await this.refs.livePaymentMethodsOfChannelIn(tx, 'POS');
      // The server's own reason for a difference found at sync (A-286 (d)) is never offered to a cashier.
      const reasons = (await this.refs.reasonCodesOfDomainsIn(tx, [OVERRIDE_DOMAIN, CASH_DOMAIN])).filter((r) => (r.domain !== CASH_DOMAIN || CASH_REASONS.has(r.code)) && r.code !== OFFLINE_PACK_PRICE);
      const [perLine, perShift] = await Promise.all([this.authoriser.limitIn(tx, actor!, 'PRICE_OVERRIDE_PER_LINE', branchId), this.authoriser.limitIn(tx, actor!, 'PRICE_OVERRIDE_PER_SHIFT', branchId)]);
      // Cash only offline by default: the methods allowed offline, and mobile money too only when the branch allows a
      // supervisor-approved unverified tender (OFFLINE_SYNC 5.2: both must be on for mobile money).
      const offlineMethods = methods.filter((m) => (m.allowedOffline && m.kind !== 'MOBILE_MONEY') || (m.kind === 'MOBILE_MONEY' && unverifiedMobileMoney));

      const prices = await this.animalPricesIn(tx, branchId, now, selling.products, standing, facts);

      const baseUoms = [...(await this.refs.productsIn(tx, selling.products.map((p) => p.product.id))).values()].map((p) => p.baseUom);
      const uoms = await this.refs.unitsIn(tx, [...selling.products.flatMap((p) => [p.saleUom, ...p.units.map((u) => u.uom)]), ...baseUoms]);

      const view: OfflinePackView = {
        register: { id: register.id, code: register.code, name: register.name },
        nextShiftSeq: await this.store.nextShiftSeq(tx, register.id),
        receiptLinkTemplate: this.linkTemplate,
        generatedAt: now.toISOString(),
        validUntil: packValidUntil(now, maxHours).toISOString(),
        priceListVersionIds: selling.priceListVersionIds,
        taxSchemeVersionId: scheme.versionId,
        taxCells: scheme.cells,
        products: selling.products.map((p) => {
          const first = p.units[0]!;
          return {
            product: p.product,
            saleUom: p.saleUom,
            taxCategoryId: p.taxCategoryId,
            priceBasis: first.basis,
            priceBand: bandOf(first),
            priceListEntryId: first.priceListEntryId,
            quoteOnly: first.quoteOnly,
            taxInclusive: first.taxInclusive,
            tileCategory: p.categoryName,
            sellingUnits: p.units.map((u) => ({ uom: u.uom, priceListEntryId: u.priceListEntryId, priceBand: bandOf(u), quoteOnly: u.quoteOnly })),
          };
        }),
        stockUnits: standing.map((u) => {
          const fact = facts.get(u.stockUnitId);
          const price = prices.get(u.stockUnitId)!;
          return {
            id: u.stockUnitId,
            identifier: u.identifier,
            productId: u.productId,
            locationId: u.locationId,
            gradeId: fact?.gradeId ?? null,
            lastWeightKg: fact?.lastWeightKg ?? null,
            lastWeighedAt: fact?.lastWeighedAt?.toISOString() ?? null,
            lastWeightSource: price.weightSource,
            sellable: u.sellable,
            priceListEntryId: price.priceListEntryId,
            priceBand: price.priceBand,
            unpricedReason: price.unpricedReason,
          };
        }),
        paymentMethods: methods.map((m) => ({ id: m.id, code: m.code, name: m.name, kind: m.kind })),
        uoms: uoms.map((u) => ({ code: u.code, name: u.name, singularName: u.singularName, pluralName: u.pluralName, displayDecimals: u.displayDecimals })),
        reasonCodes: reasons.map((r) => ({ code: r.code, domain: r.domain, description: r.description, requiresNote: r.requiresNote, lossAccountGroup: r.lossAccountGroup })),
        policy: {
          maxOfflineHours: maxHours,
          maxQueuedSales: maxQueued,
          offlineTenderMethodIds: offlineMethods.map((m) => m.id),
          priceOverrideLimitPerLinePesewas: Money.ofPesewas(perLine).toJsonInteger(),
          priceOverrideLimitPerShiftPesewas: Money.ofPesewas(perShift).toJsonInteger(),
          pinMaxWrongTries: PIN_MAX_WRONG_TRIES,
        },
        currency: 'GHS',
      };
      await this.audit.record(tx, {
        module: 'pos',
        action: 'ISSUE_OFFLINE_PACK',
        entityType: 'Register',
        entityId: register.id,
        branchId,
        before: null,
        after: { deviceId: device.id, generatedAt: view.generatedAt, validUntil: view.validUntil, priceListVersionIds: [...view.priceListVersionIds], taxSchemeVersionId: view.taxSchemeVersionId, products: view.products.length, stockUnits: view.stockUnits.length, pricedAnimals: view.stockUnits.filter((u) => u.priceBand !== null).length },
      });
      return view;
    });
  }

  /**
   * Each standing unit's own price (CR-052, A-286): every sellable animal priced by the engine as the counter would for a
   * buyer with no account, one head in the first unit its product is sold by here, from that animal's own grade and
   * latest weight, never derived; with its latest weighing's source when that weighing is the weight priced (LIV's
   * history, FR-LIV-004). A lot carries no price of its own.
   */
  private async animalPricesIn(
    tx: Transaction,
    branchId: string,
    at: Date,
    products: readonly { readonly product: { readonly id: string }; readonly baseUom: string; readonly units: readonly SellingUnitView[] }[],
    standing: readonly StandingUnit[],
    facts: UnitFacts,
  ): Promise<ReadonlyMap<string, AnimalPrice & { readonly weightSource: 'SCALE' | 'MANUAL' | 'ESTIMATE' | null }>> {
    const sold = new Map(products.map((p) => [p.product.id, p] as const));
    const animals = standing.filter((u) => facts.get(u.stockUnitId)?.tracking === 'SERIAL');
    const asked = animals.filter((u) => u.sellable && sold.has(u.productId));
    const resolved =
      asked.length === 0
        ? new Map()
        : new Map(
            (
              await this.pricing.resolveIn(tx, {
                channel: 'POS',
                branchId,
                at,
                lines: asked.map((u) => {
                  const fact = facts.get(u.stockUnitId)!;
                  const product = sold.get(u.productId)!;
                  const uom = product.units[0]!.uom;
                  return {
                    lineRef: u.stockUnitId,
                    productId: u.productId,
                    quantity: ONE_HEAD,
                    ...(uom === product.baseUom ? {} : { uom }),
                    ...(fact.gradeId === null ? {} : { gradeId: fact.gradeId }),
                    ...(fact.lastWeightKg === null ? {} : { weightKg: fact.lastWeightKg }),
                  };
                }),
              })
            ).lines.map((l) => [l.lineRef, l] as const),
          );
    const weighings = await this.weighing.latestIn(tx, animals.map((u) => u.stockUnitId));
    const prices = new Map<string, AnimalPrice & { readonly weightSource: 'SCALE' | 'MANUAL' | 'ESTIMATE' | null }>();
    for (const u of standing) {
      const fact = facts.get(u.stockUnitId);
      const weighing = weighings.get(u.stockUnitId);
      const weightSource = weighing !== undefined && fact?.lastWeightKg !== null && fact?.lastWeightKg !== undefined && weighing.weightKg === fact.lastWeightKg ? weighing.weightSource : null;
      prices.set(u.stockUnitId, { ...animalPrice({ tracking: fact?.tracking ?? 'LOT', sellable: u.sellable }, resolved.get(u.stockUnitId)), weightSource });
    }
    return prices;
  }
}

/** One animal, as a counter line sells it. */
const ONE_HEAD = '1.000';

type StandingUnit = Awaited<ReturnType<StockQueries['unitsStandingAtIn']>>[number];
type UnitFacts = Awaited<ReturnType<StockUnits['factsIn']>>;

function bandOf(unit: SellingUnitView): PriceBandView | null {
  return unit.band === null
    ? null
    : {
        listPricePesewas: Money.ofPesewas(unit.band.listPricePesewas).toJsonInteger(),
        floorPricePesewas: Money.ofPesewas(unit.band.floorPricePesewas).toJsonInteger(),
        ceilingPricePesewas: Money.ofPesewas(unit.band.ceilingPricePesewas).toJsonInteger(),
        basis: unit.band.basis,
      };
}
