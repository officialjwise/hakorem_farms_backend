import { toBusinessDate, type Clock } from '@hakorem/kernel';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { AsyncConsumer, EventEnvelope } from '../../../platform/events/domain-events';
import type { OutboxHistory } from '../../../platform/events/outbox-history';
import type { Settings } from '../../../platform/settings/settings';
import type { MasterDataRefs } from '../../mdm';
import { classify, CLASSIFIED_EVENT_TYPES, unlinkedTillReceipt, type ExceptionDraft, type SourceEvent } from '../domain/classify';
import { INVESTOR_ITEM_PERMISSION } from '../domain/exception-kinds';
import type { ExceptionStore, StoredDraft } from './exception-store';

export const EXCEPTION_PROJECTOR = 'rpt.exception-items';

/** SA-17 and abuse case 70: a payment within 24 hours after the payee's payout details changed. */
const PAYOUT_CHANGE_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * R18: an address that ended this many checkouts unpaid in a day, with none completed, is an item. The default of AUD's
 * setting `rpt.checkout_holding.unpaid_checkouts`, which only the Owner changes (A-390 approved by the owner,
 * 2026-11-24); each checkout is judged by the value in force when it ended, so a later change, a redelivery or a
 * rebuild never rewrites an earlier day's items.
 */
export const CHECKOUT_HOLDING_THRESHOLD = 3;
export const CHECKOUT_HOLDING_SETTING = 'rpt.checkout_holding.unpaid_checkouts';
const CHECKOUT_EVENTS = ['shp.CheckoutStarted', 'shp.CheckoutExpired', 'shp.CheckoutCancelled', 'shp.CheckoutCompleted'] as const;
const STATE_EVENTS = ['iam.ApprovalDecided', 'pur.SupplierPaymentMade', ...CHECKOUT_EVENTS] as const;
const REPLAY_PAGE = 500;
/** How the seeded farm's invented items are marked (A-392): their source key's prefix and their summary's suffix. */
const SEED_KEY = 'seed:';
const SEED_MARK = '(SEED)';

function str(p: Readonly<Record<string, unknown>>, key: string): string | null {
  const v = p[key];
  return typeof v === 'string' ? v : null;
}

/**
 * The daily exception report's projector (FR-RPT-007, FR-RPT-009, ADR-0023, ADR-0103): an asynchronous consumer of the
 * outbox that turns each event into its exception items through the domain's `classify`, keeps the few facts the
 * report needs across events (approval pairs, checkouts per address, payout changes), raises the items that need
 * them (a payment within 24 hours after a payout change; an address holding stock with checkouts it never pays), and
 * records its checkpoint. Idempotent: an item is keyed by its source, a fact by its event, so a redelivery or a
 * rebuild writes the same rows.
 */
export class ExceptionProjector {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: ExceptionStore,
    private readonly refs: MasterDataRefs,
    private readonly history: OutboxHistory,
    private readonly clock: Clock,
    private readonly settings: Settings,
  ) {}

  /** Every event type the projector reads. */
  static readonly EVENT_TYPES: readonly string[] = [...new Set([...CLASSIFIED_EVENT_TYPES, ...STATE_EVENTS])].sort();

  readonly consumer: AsyncConsumer = {
    name: EXCEPTION_PROJECTOR,
    eventTypes: ExceptionProjector.EVENT_TYPES,
    isolation: 'read committed',
    handle: async (tx, event) => {
      await this.project(tx, event);
      await this.store.checkpoint(tx, EXCEPTION_PROJECTOR, { id: event.id, recordedAt: event.recordedAt }, this.clock.now(), false);
    },
  };

  async project(tx: Transaction, event: EventEnvelope): Promise<void> {
    await this.putIn(tx, await this.draftsIn(tx, event), event.id, true);
  }

  /**
   * The seeded farm's exception day (`pnpm db:seed` only, A-392): invented source events classified exactly as the
   * outbox's are, each item marked SEED (its source key, its summary and `details.seed`) and kept in RPT's projection
   * alone. They never enter the outbox, so no other consumer acts on them, and a rebuild, which replays the outbox,
   * drops them. Answers how many items it wrote.
   */
  seedDay(events: readonly EventEnvelope[]): Promise<number> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      let written = 0;
      for (const event of events) {
        const drafts = (await this.draftsIn(tx, event)).map((d) => ({ ...d, sourceKey: `${SEED_KEY}${d.sourceKey}`, summary: `${d.summary} ${SEED_MARK}`, details: { ...d.details, seed: true } }));
        written += await this.putIn(tx, drafts, null, false);
      }
      return written;
    });
  }

  private async draftsIn(tx: Transaction, event: EventEnvelope): Promise<ExceptionDraft[]> {
    const source: SourceEvent = {
      id: event.id,
      type: event.type,
      recordedAt: event.recordedAt,
      actorId: event.actorId,
      branchId: event.branchId,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      payload: event.payload as Readonly<Record<string, unknown>>,
    };
    return [...classify(source), ...(await this.statefulIn(tx, source))];
  }

  /** Drafts stored with their Africa/Accra date; a company-wide item is kept at the head office branch. */
  async putIn(tx: Transaction, drafts: readonly ExceptionDraft[], eventRef: string | null, replace: boolean): Promise<number> {
    if (drafts.length === 0) return 0;
    const headOffice = drafts.some((d) => d.branchId === null) ? await this.refs.headOfficeBranchIn(tx) : null;
    const stored: StoredDraft[] = drafts.map((d) => ({ ...d, branchId: d.branchId ?? headOffice, exceptionDate: toBusinessDate(d.raisedAt), eventRef }));
    return this.store.putItems(tx, stored, replace);
  }

  private async statefulIn(tx: Transaction, e: SourceEvent): Promise<ExceptionDraft[]> {
    const p = e.payload;
    switch (e.type) {
      case 'iam.ApprovalDecided': {
        const maker = str(p, 'requestedBy');
        const checker = str(p, 'decidedBy');
        const decision = str(p, 'decision');
        if (maker !== null && checker !== null && (decision === 'APPROVED' || decision === 'REJECTED')) {
          const amount = typeof p['amountPesewas'] === 'number' ? BigInt(p['amountPesewas']) : null;
          await this.store.putApproval(tx, { eventId: e.id, at: e.recordedAt, date: toBusinessDate(e.recordedAt), branchId: e.branchId, kind: str(p, 'kind') ?? 'UNKNOWN', decision, makerId: maker, checkerId: checker, amountPesewas: amount });
        }
        return [];
      }
      case 'pur.SupplierPayoutChanged':
      case 'cap.InvestorPayoutChanged': {
        const supplier = e.type === 'pur.SupplierPayoutChanged';
        const partyId = supplier ? str(p, 'supplierId') : str(p, 'investorId');
        if (partyId !== null) {
          await this.store.putPayoutChange(tx, { eventId: e.id, partyKind: supplier ? 'SUPPLIER' : 'INVESTOR', partyId, changeId: str(p, 'payoutChangeId') ?? e.subjectId, at: e.recordedAt, requestedBy: str(p, 'requestedBy'), approvedBy: str(p, 'approvedBy') });
        }
        return [];
      }
      case 'pur.SupplierPaymentMade':
        return this.paymentAfterChangeIn(tx, e, 'SUPPLIER', str(p, 'supplierId'), [13]);
      case 'cap.DistributionPaid':
        return this.paymentAfterChangeIn(tx, e, 'INVESTOR', str(p, 'investorId'), [70]);
      case 'ntf.MessageSuppressed': {
        // A till sale that sent no receipt token is counted, not listed (the owner, 2026-11-25, A-400).
        const unlinked = unlinkedTillReceipt(e);
        if (unlinked !== null) {
          await this.store.putUnlinkedReceipt(tx, { messageId: str(p, 'messageId') ?? e.subjectId, eventId: e.id, salesOrderId: unlinked.salesOrderId, branchId: unlinked.branchId, date: toBusinessDate(e.recordedAt), at: e.recordedAt });
        }
        return [];
      }
      case 'shp.CheckoutStarted':
      case 'shp.CheckoutExpired':
      case 'shp.CheckoutCancelled':
      case 'shp.CheckoutCompleted':
        return this.checkoutIn(tx, e);
      default:
        return [];
    }
  }

  private async paymentAfterChangeIn(tx: Transaction, e: SourceEvent, party: 'SUPPLIER' | 'INVESTOR', partyId: string | null, abuseCases: number[]): Promise<ExceptionDraft[]> {
    if (partyId === null) return [];
    const changes = await this.store.payoutChangesWithin(tx, party, partyId, new Date(e.recordedAt.getTime() - PAYOUT_CHANGE_WINDOW_MS), e.recordedAt);
    const last = changes.at(-1);
    if (last === undefined) return [];
    const amount = typeof e.payload['amountPesewas'] === 'number' ? BigInt(e.payload['amountPesewas']) : null;
    const hours = Math.floor((e.recordedAt.getTime() - last.changedAt.getTime()) / 3_600_000);
    const paymentId = str(e.payload, party === 'SUPPLIER' ? 'supplierPaymentId' : 'paymentId') ?? e.subjectId;
    return [
      {
        sourceKey: `${e.id}:PAYMENT_AFTER_PAYOUT_CHANGE`,
        kind: 'PAYMENT_AFTER_PAYOUT_CHANGE',
        sourceKind: party,
        severity: 'URGENT',
        abuseCases,
        branchId: str(e.payload, 'branchId') ?? e.branchId,
        actorId: e.actorId,
        subject: { id: paymentId, docType: party === 'SUPPLIER' ? 'SUPPLIER_PAYMENT' : 'DISTRIBUTION_PAYMENT' },
        amountPesewas: amount,
        summary: `A ${party === 'SUPPLIER' ? 'supplier' : 'distribution'} payment made ${hours} hour(s) after the payee's payout details changed`,
        details: { sourceEvent: { id: e.id, type: e.type }, party, partyId, payoutChangeId: last.changeId, changedAt: last.changedAt.toISOString(), changeRequestedBy: last.requestedBy, changeApprovedBy: last.approvedBy, hoursAfterChange: hours },
        raisedAt: e.recordedAt,
        restrictedTo: party === 'INVESTOR' ? INVESTOR_ITEM_PERMISSION : null,
      },
    ];
  }

  private async checkoutIn(tx: Transaction, e: SourceEvent): Promise<ExceptionDraft[]> {
    const checkoutId = str(e.payload, 'checkoutId') ?? e.subjectId;
    if (e.type === 'shp.CheckoutStarted') {
      await this.store.putCheckout(tx, checkoutId, str(e.payload, 'clientAddressHash'), e.recordedAt, toBusinessDate(e.recordedAt), 'STARTED');
      return [];
    }
    const outcome = e.type === 'shp.CheckoutCompleted' ? 'COMPLETED' : e.type === 'shp.CheckoutExpired' ? 'EXPIRED' : 'CANCELLED';
    await this.store.putCheckout(tx, checkoutId, null, e.recordedAt, toBusinessDate(e.recordedAt), outcome);
    const started = await this.store.checkoutsOf(tx, checkoutId);
    if (started === null || started.addressHash === null || outcome === 'COMPLETED') return [];
    const counts = await this.store.checkoutCounts(tx, started.addressHash, started.date);
    const threshold = await this.settings.integerAt(CHECKOUT_HOLDING_SETTING, CHECKOUT_HOLDING_THRESHOLD, e.recordedAt);
    if (counts.unpaid < threshold || counts.completed > 0) return [];
    return [
      {
        // One item per address and day, its counts brought up to date by each later checkout that ends unpaid.
        sourceKey: `checkout-holding:${started.addressHash}:${started.date}`,
        kind: 'CHECKOUT_HOLDING',
        sourceKind: null,
        severity: 'REVIEW',
        abuseCases: [],
        branchId: e.branchId,
        actorId: null,
        subject: null,
        amountPesewas: null,
        summary: `One address started ${counts.started} storefront checkouts on ${started.date} and let ${counts.unpaid} end unpaid, holding stock each time`,
        details: { sourceEvent: { id: e.id, type: e.type }, residualRisk: 'R18', addressHash: started.addressHash, started: counts.started, unpaid: counts.unpaid, completed: counts.completed, threshold },
        raisedAt: e.recordedAt,
        restrictedTo: null,
      },
    ];
  }

  /**
   * The projection rebuilt (FR-RPT-009's rebuild, ADR-0023): emptied, then every event replayed from the outbox in
   * order, in one transaction; reviews are kept, since an item's id is fixed by its source. The sweep's items are
   * raised again by the next sweep of their days.
   */
  rebuild(): Promise<{ readonly events: number; readonly items: number }> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.store.clearProjections(tx);
      let last: EventEnvelope | null = null;
      let events = 0;
      for (;;) {
        const page = await this.history.messagesAfter(tx, ExceptionProjector.EVENT_TYPES, last?.id ?? null, REPLAY_PAGE);
        for (const event of page) await this.project(tx, event);
        events += page.length;
        last = page.at(-1) ?? last;
        if (page.length < REPLAY_PAGE) break;
      }
      await this.store.checkpoint(tx, EXCEPTION_PROJECTOR, last === null ? null : { id: last.id, recordedAt: last.recordedAt }, this.clock.now(), true);
      const items = await this.store.countItems(tx);
      return { events, items };
    });
  }
}
