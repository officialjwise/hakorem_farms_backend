import { createHash } from 'node:crypto';
import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { databaseErrorOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import { ApiError, NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import { PaymentProviderError, type ProviderDispute, type ProviderTransaction, type ProviderWebhookEvent } from '../../../platform/payments/payment-provider';
import type { ResilientPaymentProvider } from '../../../platform/payments/resilient-provider';
import type { Settings } from '../../../platform/settings/settings';
import { judgeWebhookEvent } from '../domain/webhook';
import type { WebhookRejected } from '../events';
import type { Breaks } from './breaks';
import type { PaymentStore, WebhookOutcome, WebhookRow } from './payment-store';
import { answerOf, CARD_MONEY_ABUSE_CASE, PROVIDER, type ProviderPayments } from './provider-payments';

export const WEBHOOK_REJECTED = 'pay.WebhookRejected';
/** The principal a provider's webhook acts as (migration 0164): it holds no grant. */
export const WEBHOOK_ACTOR: Actor = { principalId: '01900000-0000-7000-8000-000000000007', kind: 'SYSTEM', displayName: 'Payment provider webhook', realm: null, sessionId: null, steppedUpAt: null };
/** Seconds either side of the server's clock an event's own time may lie (FR-PAY-004, SA-03). */
export const WEBHOOK_WINDOW_SETTING = 'pay.webhook_window_seconds';
const DEFAULT_WINDOW_SECONDS = 300;
const REJECTIONS: ReadonlySet<WebhookOutcome> = new Set(['REJECTED_SIGNATURE', 'REJECTED_STALE', 'REJECTED_AMOUNT', 'REJECTED_MALFORMED']);
/** Abuse case 5: a forged webhook marks an order paid (docs/security/THREAT_MODEL.md). */
const FORGED_WEBHOOK_ABUSE_CASE = 5;
const UNIQUE_VIOLATION = '23505';

/** 401 with no detail: a webhook whose signature is not the provider's (FR-PAY-006: the response names no check). */
export class WebhookUnauthenticatedError extends ApiError {
  readonly status = 401;
  readonly code = 'UNAUTHENTICATED';
  readonly messageKey = 'error.unauthenticated';
}

export interface ReceivedWebhook {
  readonly provider: string;
  readonly rawBody: Buffer;
  readonly signature: string | undefined;
  readonly sourceIp: string | null;
  readonly correlationId: string | null;
}

/**
 * `receivePaymentWebhook` (FR-PAY-004 to FR-PAY-008, security architecture section 8, the owner's order of
 * 2026-11-16): every request is logged in `pay.webhook_event`. The signature over the raw body is checked first, in
 * constant time; then the event's own time against the window; then the event is processed once by the provider's
 * reference (`<event>:<reference>`, a unique key: a second delivery is logged REPLAYED and posts nothing); only then
 * are the amount and status re-checked by a server-to-server lookup, and the payment clears through
 * `ProviderPayments.settleIn` in the same transaction as the event's row. The webhook's own amount is never trusted: one
 * that differs from the provider's record is rejected. A reference we never initiated is logged and, if the provider
 * says the money was taken, raised as a break; nothing is posted against a guess.
 */
export class PaymentWebhooks {
  private readonly nextId: () => string;

  constructor(
    private readonly store: PaymentStore,
    private readonly providerPayments: ProviderPayments,
    private readonly provider: ResilientPaymentProvider,
    private readonly breaks: Breaks,
    private readonly events: DomainEvents,
    private readonly audit: AuditTrail,
    private readonly settings: Settings,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  async receive(webhook: ReceivedWebhook): Promise<{ readonly received: true }> {
    if (webhook.provider !== PROVIDER) throw new NotFoundError('no such payment provider');
    const receivedAt = this.clock.now();
    const base = {
      provider: PROVIDER,
      payloadHash: createHash('sha256').update(webhook.rawBody).digest(),
      sourceIp: webhook.sourceIp,
      correlationId: webhook.correlationId,
      receivedAt,
      actorId: WEBHOOK_ACTOR.principalId,
    };
    // The signature over the raw bytes first (B09c): nothing an unsigned body says is parsed, read or kept.
    if (!this.provider.webhookSignatureValid(webhook.rawBody, webhook.signature)) {
      await this.record({ ...base, eventId: null, eventType: null, signatureValid: false, withinTimeWindow: null, payload: {}, reference: null, paymentId: null, outcome: 'REJECTED_SIGNATURE' });
      throw new WebhookUnauthenticatedError('webhook signature refused');
    }
    const body = parseJson(webhook.rawBody);
    const event = body === undefined ? null : this.provider.readWebhook(body);
    if (event === null) {
      await this.record({ ...base, eventId: null, eventType: null, signatureValid: true, withinTimeWindow: null, payload: {}, reference: null, paymentId: null, outcome: 'REJECTED_MALFORMED' });
      return { received: true };
    }
    const signed = { ...base, eventId: event.eventId, eventType: event.eventType, signatureValid: true, payload: event.evidence, reference: event.reference };
    const windowSeconds = await this.settings.integer(WEBHOOK_WINDOW_SETTING, DEFAULT_WINDOW_SECONDS);
    const judged = judgeWebhookEvent({ eventType: event.eventType, eventAt: event.occurredAt, now: receivedAt, windowSeconds });
    const within = judged === 'IGNORED_EVENT_TYPE' ? null : judged === 'PROCEED';
    const seen = await this.uow.run({ isolation: 'read committed' }, (tx) => this.store.webhookSeen(tx, PROVIDER, event.eventId));
    if (seen) {
      await this.record({ ...signed, withinTimeWindow: within, paymentId: null, outcome: 'REPLAYED' });
      return { received: true };
    }
    if (judged !== 'PROCEED') {
      // A stale or ignored event is logged without taking the event's key: it never reaches processing.
      await this.record({ ...signed, withinTimeWindow: within, paymentId: null, outcome: judged });
      return { received: true };
    }
    if (event.disputeId !== undefined) {
      await this.receiveDispute({ ...signed, withinTimeWindow: true }, event, event.disputeId);
      return { received: true };
    }
    const charge = await this.uow.run({ isolation: 'read committed' }, (tx) => this.store.chargeByReference(tx, PROVIDER, event.reference));
    let found: ProviderTransaction | null = null;
    try {
      found = await this.provider.lookup(event.reference);
    } catch (error) {
      if (!(error instanceof PaymentProviderError)) throw error;
      this.logger.warn({ kind: error.kind }, 'webhook lookup failed; the sweep looks the charge up');
    }
    if (charge === null) {
      await this.recordOnce({ ...signed, withinTimeWindow: true, paymentId: null, outcome: 'IGNORED_UNKNOWN_REFERENCE' }, async (tx) => {
        if (found?.status === 'SUCCESS') {
          await this.breaks.raiseIn(tx, WEBHOOK_ACTOR.principalId, {
            kind: 'PROVIDER_REFERENCE_UNKNOWN',
            branchId: null,
            paymentId: null,
            refundId: null,
            provider: PROVIDER,
            reference: event.reference,
            amountPesewas: found.amountPesewas,
            details: { providerTransactionId: found.providerTransactionId, currency: found.currency, source: 'WEBHOOK' },
          });
        }
      });
      return { received: true };
    }
    if (found === null) {
      await this.recordOnce({ ...signed, withinTimeWindow: true, paymentId: charge.paymentId, outcome: 'DEFERRED_LOOKUP' });
      return { received: true };
    }
    const answer = found;
    await this.recordOnce({ ...signed, withinTimeWindow: true, paymentId: charge.paymentId, outcome: 'ACCEPTED' }, async (tx) => {
      if (answer.amountPesewas !== event.amountPesewas) return 'REJECTED_AMOUNT';
      const decision = await this.providerPayments.settleIn(tx, event.reference, answerOf(answer), 'PROVIDER_CALLBACK', WEBHOOK_ACTOR.principalId);
      return decision?.kind === 'AMOUNT_DIFFERS' ? 'REJECTED_AMOUNT' : 'ACCEPTED';
    });
    return { received: true };
  }

  /**
   * A chargeback opened at the provider (B09c, abuse case 45), after the same signature, window and once-only checks
   * as a payment: the dispute is looked up server to server and must name the same payment and amount, else the event
   * is REJECTED_AMOUNT and raises nothing. A dispute on a payment of ours is raised once as an URGENT break, with
   * nothing posted: a person answers it at the provider, and a refund, if any, goes through the refund flow. A lookup
   * that cannot be made still raises it, marked unconfirmed, since a flag for a person moves no money.
   */
  private async receiveDispute(signed: Omit<WebhookRow, 'id' | 'paymentId' | 'outcome'>, event: ProviderWebhookEvent, disputeId: string): Promise<void> {
    const charge = await this.uow.run({ isolation: 'read committed' }, (tx) => this.store.chargeByReference(tx, PROVIDER, event.reference));
    let found: ProviderDispute | null = null;
    try {
      found = await this.provider.lookupDispute(disputeId);
    } catch (error) {
      if (!(error instanceof PaymentProviderError)) throw error;
      this.logger.warn({ kind: error.kind }, 'dispute lookup failed; raised unconfirmed');
    }
    if (charge === null) {
      await this.recordOnce({ ...signed, paymentId: null, outcome: 'IGNORED_UNKNOWN_REFERENCE' });
      return;
    }
    await this.recordOnce({ ...signed, paymentId: charge.paymentId, outcome: 'ACCEPTED' }, async (tx) => {
      if (found !== null && (found.reference !== event.reference || found.amountPesewas !== event.amountPesewas)) return 'REJECTED_AMOUNT';
      const [payment] = await this.store.payments(tx, [charge.paymentId]);
      const raised = await this.breaks.raiseIn(
        tx,
        WEBHOOK_ACTOR.principalId,
        {
          kind: 'PROVIDER_DISPUTE_OPENED',
          branchId: payment!.branchId,
          paymentId: charge.paymentId,
          refundId: null,
          provider: PROVIDER,
          reference: event.reference,
          amountPesewas: (found ?? event).amountPesewas,
          details: { disputeId, status: found?.status ?? null, currency: found?.currency ?? null, confirmedByLookup: found !== null },
        },
        { severity: 'URGENT', abuseCases: [CARD_MONEY_ABUSE_CASE] },
      );
      if (raised) await this.audit.record(tx, { module: 'pay', action: 'DISPUTE', entityType: 'Payment', entityId: charge.paymentId, branchId: payment!.branchId, before: null, after: { disputeId, confirmedByLookup: found !== null } });
      return found === null ? 'DEFERRED_LOOKUP' : 'ACCEPTED';
    });
  }

  /**
   * Records a validly signed event under its unique key, with whatever it does in the same transaction; a delivery
   * that lost the race for the key is recorded as REPLAYED instead and does nothing.
   */
  private async recordOnce(row: Omit<WebhookRow, 'id'>, effect?: (tx: Transaction) => Promise<WebhookOutcome | void>): Promise<void> {
    try {
      await this.uow.run({ isolation: 'serializable' }, async (tx) => {
        const outcome = (await effect?.(tx)) ?? row.outcome;
        await this.insert(tx, { ...row, outcome });
      });
    } catch (error) {
      if (databaseErrorOf(error)?.code !== UNIQUE_VIOLATION) throw error;
      await this.record({ ...row, outcome: 'REPLAYED' });
    }
  }

  private async record(row: Omit<WebhookRow, 'id'>): Promise<void> {
    await this.uow.run({ isolation: 'read committed' }, (tx) => this.insert(tx, row));
  }

  private async insert(tx: Transaction, row: Omit<WebhookRow, 'id'>): Promise<void> {
    const id = this.nextId();
    await this.store.insertWebhook(tx, { ...row, id });
    if (!REJECTIONS.has(row.outcome)) return;
    const payload: WebhookRejected = { webhookEventId: id, provider: row.provider, outcome: row.outcome, abuseCases: [FORGED_WEBHOOK_ABUSE_CASE] };
    await this.events.publish(tx, { type: WEBHOOK_REJECTED, subjectType: 'WebhookEvent', subjectId: id, payload });
    await this.audit.record(tx, { module: 'pay', action: 'WEBHOOK_REJECTED', entityType: 'WebhookEvent', entityId: id, before: null, after: { provider: row.provider, outcome: row.outcome, eventType: row.eventType, sourceIp: row.sourceIp } });
    this.logger.warn({ webhookEventId: id, outcome: row.outcome, alert: 'WEBHOOK_REJECTED' }, 'payment webhook rejected');
  }
}

function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}
