import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import type { Actor } from '../../../platform/context/request-context';
import type { UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError, UnauthenticatedError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import { afterReport, type ReportedStatus } from '../domain/messages';
import { readReply } from '../domain/routing';
import type { DeliveryReportRejected, MessageFailed } from '../events';
import { MESSAGE_FAILED } from './message-sender';
import type { NtfStore, ProviderReportRecord, ReportOutcome } from './ntf-store';
import type { OptOuts } from './opt-outs';

export const DELIVERY_REPORT_REJECTED = 'ntf.DeliveryReportRejected';
/** The principal a messaging provider's webhook acts as (migration 0336): it holds no grant. */
export const MESSAGING_WEBHOOK_ACTOR: Actor = { principalId: '01900000-0000-7000-8000-000000000008', kind: 'SYSTEM', displayName: 'Messaging provider webhook', realm: null, sessionId: null, steppedUpAt: null };
/** The SMS adapter's provider code in the webhook's path (`generic-http`, docs/OPERATIONS.md section 3.6; A-374 (d)). */
export const SMS_PROVIDER = 'GENERIC_HTTP';
/** Abuse case 57: a forged or replayed delivery report, or a template edited to carry a phishing link. */
export const FORGED_REPORT_ABUSE_CASE = 57;
const SIGNATURE = /^[0-9a-f]{64}$/;
const REPORTED: Readonly<Record<string, ReportedStatus>> = { DELIVERED: 'DELIVERED', FAILED: 'FAILED', UNDELIVERED: 'FAILED', REJECTED: 'FAILED', EXPIRED: 'FAILED' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ReceivedReport {
  readonly provider: string;
  readonly rawBody: Buffer;
  readonly signature: string | undefined;
  readonly sourceIp: string | null;
}

interface DeliveryReport {
  readonly reportId: string;
  readonly messageId: string;
  readonly status: ReportedStatus;
}

/** A reply from a phone (B11 continued 11): the provider's id for it, the number it came from and its text. */
interface InboundReply {
  readonly kind: 'INBOUND';
  readonly reportId: string;
  readonly from: string;
  readonly text: string;
}

const E164 = /^\+[1-9][0-9]{7,14}$/;

/** A delivery report's or a reply's body as the `generic-http` adapter's provider sends it, or null for anything else. */
function readReport(raw: Buffer): DeliveryReport | InboundReply | null {
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b['type'] === 'inbound') {
    if (typeof b['id'] !== 'string' || b['id'].length === 0 || b['id'].length > 200) return null;
    if (typeof b['from'] !== 'string' || !E164.test(b['from']) || typeof b['text'] !== 'string' || b['text'].length > 1_600) return null;
    return { kind: 'INBOUND', reportId: b['id'], from: b['from'], text: b['text'] };
  }
  if (b['type'] !== 'delivery' || typeof b['id'] !== 'string' || b['id'].length === 0 || b['id'].length > 200) return null;
  if (typeof b['reference'] !== 'string' || !UUID.test(b['reference'])) return null;
  const status = typeof b['status'] === 'string' && Object.hasOwn(REPORTED, b['status']) ? REPORTED[b['status']]! : null;
  return status === null ? null : { reportId: b['id'], messageId: b['reference'], status };
}

/**
 * `receiveMessagingWebhook` (FR-NTF-007, abuse case 57, the owner 2026-11-23: each message's delivery recorded per
 * channel, so a failed one shows as failed). Public: the signature over the raw body (HMAC-SHA256 under
 * `SMS_WEBHOOK_SECRET`, compared in constant time) is the only credential, checked before anything the body says is
 * read. Every request is logged in `ntf.provider_report`. A report is applied once by the provider's report id (a second
 * delivery is logged REPLAYED and changes nothing), and it changes only the message's delivery status: a SENT message
 * becomes DELIVERED or FAILED, nothing else moves and no other column is written. A reply from a phone (B11 continued 11,
 * FR-NTF-005) is applied once by its id: STOP and its kin record an opt-out of SMS for that number at once, START an
 * opt-in (`OptOuts.recordReplyIn`); any other text is logged IGNORED. Only a signed reply reaches here, so a forged STOP
 * from someone who is not the provider changes nothing (abuse case 59).
 */
export class DeliveryReports {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: NtfStore,
    private readonly events: DomainEvents,
    private readonly optOuts: OptOuts,
    private readonly secret: string | undefined,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  async receive(report: ReceivedReport): Promise<{ readonly received: true }> {
    if (report.provider !== SMS_PROVIDER) throw new NotFoundError('no such messaging provider');
    const receivedAt = this.clock.now();
    const base = { provider: SMS_PROVIDER, payloadHash: createHash('sha256').update(report.rawBody).digest(), sourceIp: report.sourceIp, receivedAt, actorId: MESSAGING_WEBHOOK_ACTOR.principalId };
    if (!this.signatureValid(report.rawBody, report.signature)) {
      await this.reject({ ...base, id: this.nextId(), reportKey: null, outcome: 'REJECTED_SIGNATURE', messageId: null, reportedStatus: null });
      throw new UnauthenticatedError('messaging webhook signature refused');
    }
    const read = readReport(report.rawBody);
    if (read === null) {
      await this.reject({ ...base, id: this.nextId(), reportKey: null, outcome: 'REJECTED_MALFORMED', messageId: null, reportedStatus: null });
      return { received: true };
    }
    if ('kind' in read) {
      const instruction = readReply(read.text);
      await this.uow.run({ isolation: 'serializable' }, async (tx) => {
        const id = this.nextId();
        const first = await this.store.insertReport(tx, { ...base, id, reportKey: read.reportId, outcome: instruction === null ? 'IGNORED' : 'APPLIED', messageId: null, reportedStatus: null });
        if (!first) {
          await this.store.insertReport(tx, { ...base, id: this.nextId(), reportKey: read.reportId, outcome: 'REPLAYED', messageId: null, reportedStatus: null });
          return;
        }
        if (instruction !== null) await this.optOuts.recordReplyIn(tx, { providerReportId: id, from: read.from, instruction, at: receivedAt });
      });
      return { received: true };
    }
    await this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const message = await this.store.message(tx, read.messageId, true);
      const next = message === null ? null : afterReport(message.status, read.status);
      const outcome: ReportOutcome = message === null ? 'UNKNOWN_MESSAGE' : next === null ? 'NO_CHANGE' : 'APPLIED';
      const first = await this.store.insertReport(tx, { ...base, id: this.nextId(), reportKey: read.reportId, outcome, messageId: message?.id ?? null, reportedStatus: read.status });
      if (!first) {
        await this.store.insertReport(tx, { ...base, id: this.nextId(), reportKey: read.reportId, outcome: 'REPLAYED', messageId: message?.id ?? null, reportedStatus: read.status });
        return;
      }
      if (message === null || next === null) return;
      await this.store.applyReport(tx, message.id, next, receivedAt, MESSAGING_WEBHOOK_ACTOR.principalId);
      if (next === 'FAILED') {
        await this.events.publish<MessageFailed>(tx, {
          type: MESSAGE_FAILED,
          subjectType: 'NotificationMessage',
          subjectId: message.id,
          branchId: message.branchId,
          payload: { messageId: message.id, templateCode: message.templateCode, channel: message.channel, attempts: message.attempts, reason: 'reported undelivered by the provider', salesOrderId: message.salesOrderId, failedAt: receivedAt.toISOString() },
        });
      }
    });
    return { received: true };
  }

  private signatureValid(raw: Buffer, signature: string | undefined): boolean {
    if (this.secret === undefined || signature === undefined || !SIGNATURE.test(signature)) return false;
    const expected = createHmac('sha256', this.secret).update(raw).digest();
    return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  }

  /** A refused request is logged and published in its own transaction, so it outlives the refusal (abuse case 57). */
  private async reject(row: ProviderReportRecord): Promise<void> {
    await this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.store.insertReport(tx, row);
      await this.events.publish<DeliveryReportRejected>(tx, {
        type: DELIVERY_REPORT_REJECTED,
        subjectType: 'ProviderReport',
        subjectId: row.id,
        payload: { reportId: row.id, provider: row.provider, outcome: row.outcome as 'REJECTED_SIGNATURE' | 'REJECTED_MALFORMED', sourceIp: row.sourceIp, abuseCases: [FORGED_REPORT_ABUSE_CASE] },
      });
    });
    this.logger.warn({ provider: row.provider, outcome: row.outcome }, 'messaging webhook refused');
  }
}
