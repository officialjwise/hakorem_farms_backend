import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import type { UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DomainEvents } from '../../../platform/events/domain-events';
import { scrubString } from '../../../platform/logging/log-scrubber';
import { NotificationSendError, type NotificationChannel } from '../../../platform/notifications/notification-channel';
import { afterAttempt, CLAIM_LEASE_MS, maskAddress, retryDelayMs, type AttemptOutcome } from '../domain/messages';
import { quietHoursApply, quietUntil, suppressibleByOptOut } from '../domain/routing';
import type { Channel } from '../domain/templates';
import type { MessageFailed } from '../events';
import type { RecipientFacts } from './message-queue';
import type { ClaimedMessage, NtfStore, SendResult } from './ntf-store';

export const MESSAGE_FAILED = 'ntf.MessageFailed';
/** Messages one pass of the sender claims. */
export const SEND_BATCH = 50;
const MAX_RESPONSE_LENGTH = 500;

export interface SendPass {
  readonly claimed: number;
  readonly sent: number;
  readonly retrying: number;
  readonly failed: number;
  readonly suppressed: number;
  /** Reminders and marketing handed back until quiet hours end (FR-NTF-006, B11 continued 11). */
  readonly deferred: number;
  /** A provider failed temporarily, so the rest of the pass was put back for the next one (the circuit opened). */
  readonly circuitOpen: boolean;
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return scrubString(text).slice(0, MAX_RESPONSE_LENGTH);
}

/**
 * Sends the queued messages (FR-NTF-003, FR-NTF-007, ADR-0010), run by the worker every few seconds as the Scheduler,
 * never inside a business transaction. A pass claims due messages in one short transaction (`FOR UPDATE SKIP LOCKED`
 * and a lease with a token only this sender knows), so two workers never hold the same message. For each, the number is
 * read again from the order's own contact through ORD (A-374 (b)), the provider is called outside any transaction with
 * the message's id as its idempotency key, and the attempt and the message's new state are written in a second short
 * transaction, only while the claim is still this sender's. A worker that dies mid-send leaves its claim to expire; the
 * next sender's call carries the same idempotency key, so a provider that honours it delivers once (A-374 (f)). A
 * temporary failure is retried with backoff and jitter up to three attempts, then FAILED; a permanent one fails at once.
 * The first temporary failure in a pass opens the circuit: the rest is handed back for the next pass.
 */
export class MessageSender {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: NtfStore,
    private readonly recipients: RecipientFacts,
    private readonly channels: ReadonlyMap<Channel, NotificationChannel>,
    private readonly events: DomainEvents,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly random: () => number = Math.random,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  async run(system: { readonly kind: 'SYSTEM'; readonly principalId: string }): Promise<SendPass> {
    if (system.kind !== 'SYSTEM') throw new Error('the message sender runs as a SYSTEM principal only');
    const token = this.nextId();
    const now = this.clock.now();
    const claimed = await this.uow.run({ isolation: 'read committed' }, (tx) =>
      this.store.claimDue(tx, { now, until: new Date(now.getTime() + CLAIM_LEASE_MS), token, limit: SEND_BATCH, actorId: system.principalId }),
    );
    const counts = { sent: 0, retrying: 0, failed: 0, suppressed: 0, deferred: 0 };
    let circuitOpen = false;
    for (const message of claimed) {
      if (circuitOpen) {
        await this.finish(message, null, null, { kind: 'QUEUED', sendAfter: this.clock.now(), reason: 'circuit open' }, system.principalId);
        continue;
      }
      const { outcome, response, result } = await this.attempt(message);
      await this.finish(message, outcome, response, result, system.principalId);
      if (result.kind === 'SENT') counts.sent += 1;
      if (result.kind === 'QUEUED') counts.retrying += 1;
      if (result.kind === 'FAILED') counts.failed += 1;
      if (result.kind === 'SUPPRESSED') counts.suppressed += 1;
      if (result.kind === 'DEFERRED') counts.deferred += 1;
      if (outcome === 'TEMPORARY_FAILURE') circuitOpen = true;
    }
    return { claimed: claimed.length, ...counts, circuitOpen };
  }

  private async attempt(message: ClaimedMessage): Promise<{ readonly outcome: AttemptOutcome | null; readonly response: string | null; readonly result: SendResult }> {
    if (message.channel === 'IN_APP') {
      if (message.principalId === null) return { outcome: null, response: null, result: { kind: 'SUPPRESSED', reason: 'NO_ADDRESS' } };
      const inApp = { id: this.nextId(), principalId: message.principalId, title: message.renderedSubject ?? message.renderedBody.slice(0, 80), body: message.renderedBody, link: message.linkPath };
      return { outcome: 'ACCEPTED', response: null, result: { kind: 'SENT', providerRef: `in-app:${inApp.id}`, addressMasked: null, addressHash: null, inApp } };
    }
    // The gates are read again now: the number as it is, a STOP since the message was queued, the recipient's quiet hours.
    const gate = await this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const phone = await this.recipients.phoneIn(tx, message);
      const optedOut = suppressibleByOptOut(message.category) ? await this.recipients.optedOutIn(tx, phone) : new Set<Channel>();
      const own = quietHoursApply(message.category) && message.customerId !== null ? this.recipients.ownQuietHours(await this.recipients.preferencesIn(tx, { customerId: message.customerId }, message.category), message.channel) : null;
      return { phone, optedOut, quietUntil: quietHoursApply(message.category) ? quietUntil(this.clock.now(), own) : null };
    });
    const phone = gate.phone;
    if (phone === null) return { outcome: null, response: null, result: { kind: 'SUPPRESSED', reason: 'NO_ADDRESS' } };
    if (gate.optedOut.has(message.channel)) return { outcome: null, response: null, result: { kind: 'SUPPRESSED', reason: 'OPTED_OUT' } };
    if (gate.quietUntil !== null) return { outcome: null, response: null, result: { kind: 'DEFERRED', sendAfter: gate.quietUntil } };
    const channel = this.channels.get(message.channel);
    if (channel === undefined) return { outcome: 'PERMANENT_FAILURE', response: `no adapter sends ${message.channel}`, result: { kind: 'FAILED', reason: `no adapter sends ${message.channel}` } };
    try {
      const sent = await channel.send({ to: phone, text: message.renderedBody, idempotencyKey: message.id });
      return { outcome: 'ACCEPTED', response: null, result: { kind: 'SENT', providerRef: sent.providerReference, addressMasked: maskAddress(phone), addressHash: this.recipients.hash(phone) } };
    } catch (error) {
      const outcome: AttemptOutcome = error instanceof NotificationSendError && !error.retryable ? 'PERMANENT_FAILURE' : 'TEMPORARY_FAILURE';
      const reason = describe(error);
      this.logger.warn({ messageId: message.id, channel: message.channel, attemptNo: message.attemptNo, outcome, err: reason }, 'message send failed');
      return afterAttempt(outcome, message.attemptNo) === 'QUEUED'
        ? { outcome, response: reason, result: { kind: 'QUEUED', sendAfter: new Date(this.clock.now().getTime() + retryDelayMs(message.attemptNo, this.random())), reason } }
        : { outcome, response: reason, result: { kind: 'FAILED', reason } };
    }
  }

  private async finish(message: ClaimedMessage, outcome: AttemptOutcome | null, response: string | null, result: SendResult, actorId: string): Promise<void> {
    const at = this.clock.now();
    await this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const mine = await this.store.finishAttempt(tx, { id: message.id, token: message.claimToken, attemptNo: message.attemptNo, outcome, providerResponse: response, result, at, actorId });
      if (!mine) {
        this.logger.warn({ messageId: message.id }, 'message claim lost before its attempt was recorded');
        return;
      }
      if (result.kind === 'FAILED') {
        const record = (await this.store.message(tx, message.id, false))!;
        await this.events.publish<MessageFailed>(tx, {
          type: MESSAGE_FAILED,
          subjectType: 'NotificationMessage',
          subjectId: message.id,
          branchId: record.branchId,
          payload: { messageId: message.id, templateCode: record.templateCode, channel: message.channel, attempts: record.attempts, reason: result.reason, salesOrderId: record.salesOrderId, failedAt: at.toISOString() },
        });
      }
    });
  }
}
