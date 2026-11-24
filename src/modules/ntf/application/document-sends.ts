import { formatCedis, toBusinessDate } from '@hakorem/kernel';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { AsyncConsumer, EventEnvelope } from '../../../platform/events/domain-events';
import type { Billing } from '../../bil';
import type { MasterDataRefs } from '../../mdm';
import type { SupplierPayments } from '../../pur';
import type { Statements } from '../../whl';
import { balanceLine, documentWord } from '../domain/messages';
import { CHANNELS, type Channel } from '../domain/templates';
import type { MessageQueue } from './message-queue';

/** The events whose message sends a document (B11 continued 13). */
export const DOCUMENT_SEND_EVENTS = ['bil.DocumentSendRequested', 'whl.StatementSendRequested', 'pur.SupplierRemittanceReady'] as const;

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const channelsOf = (value: unknown): readonly Channel[] => (Array.isArray(value) ? value.filter((c): c is Channel => typeof c === 'string' && (CHANNELS as readonly string[]).includes(c) && c !== 'IN_APP') : []);

/**
 * The document sends (ADR-0062, ADR-0099, B11 continued 13): NTF's consumer of the outbox, through the one queue
 * (`MessageQueue`). A billing document asked to be sent (`bil.DocumentSendRequested`) and a customer's statement
 * (`whl.StatementSendRequested`) go to the document's own customer; a remittance advice (`pur.SupplierRemittanceReady`)
 * goes once per payment to the payment's own supplier. The facts are read from the record's own module (BIL, WHL, PUR),
 * never the event's copy, and the address is read through MDM when the message is queued and again when it is sent. The
 * message carries a link of its own to the archived document, made by DOC at send (`{{link}}` is kept unfilled here),
 * and an email carries the archived PDF; a document not yet archived makes the message wait, never fail. One message per
 * send (BIL's copy, WHL's send) or per remittance: a redelivered event queues nothing more.
 */
export class DocumentSends {
  constructor(
    private readonly queue: MessageQueue,
    private readonly billing: Billing,
    private readonly statements: Statements,
    private readonly payments: SupplierPayments,
    private readonly refs: MasterDataRefs,
  ) {}

  readonly consumer: AsyncConsumer = {
    name: 'ntf.document-sends',
    eventTypes: DOCUMENT_SEND_EVENTS,
    isolation: 'serializable',
    handle: async (tx, event) => {
      await this.queueIn(tx, event);
    },
  };

  /** Queues the event's message in the consumer's transaction; true when this call wrote it. */
  async queueIn(tx: Transaction, event: EventEnvelope): Promise<boolean> {
    const payload = event.payload as Readonly<Record<string, unknown>>;
    if (event.type === 'pur.SupplierRemittanceReady') return this.remittanceIn(tx, event, payload);
    const sendId = asString(payload['sendId']);
    const channels = channelsOf(payload['channels']);
    if (sendId === null || channels.length === 0) return false;
    if (event.type === 'bil.DocumentSendRequested') {
      const id = asString(payload['billingDocumentId']);
      const document = id === null ? null : await this.billing.messageFactsIn(tx, id);
      if (document === null || document.customerId === null) return false;
      return this.queue.queueIn(tx, {
        event,
        code: 'DOCUMENT_SENT',
        recipient: { kind: 'CUSTOMER', customerId: document.customerId, branchId: document.branchId },
        data: { documentNo: document.documentNo ?? '', documentType: documentWord(document.kind), total: formatCedis(document.grossPesewas) },
        recordId: sendId,
        linkRecordId: document.id,
        allowedChannels: channels,
      });
    }
    const id = asString(payload['statementId']);
    const statement = id === null ? null : await this.statements.messageFactsIn(tx, id);
    if (statement === null) return false;
    return this.queue.queueIn(tx, {
      event,
      code: 'DOCUMENT_SENT',
      recipient: { kind: 'CUSTOMER', customerId: statement.customerId, branchId: statement.branchId },
      data: { documentNo: statement.statementNo ?? '', documentType: documentWord('STATEMENT'), total: balanceLine(statement.closingPesewas, statement.closingCreditPesewas) },
      recordId: sendId,
      linkRecordId: statement.id,
      allowedChannels: channels,
    });
  }

  /**
   * The remittance advice (FR-PUR-013, A-174): once per payment, to the payment's own supplier, with the figures of that
   * payment only, read from PUR's fixed remittance row. Its archive is made after the paying transaction, so the message
   * is queued now and waits at send until DOC has archived and scanned it.
   */
  private async remittanceIn(tx: Transaction, event: EventEnvelope, payload: Readonly<Record<string, unknown>>): Promise<boolean> {
    const paymentId = asString(payload['supplierPaymentId']);
    const remittance = paymentId === null ? null : await this.payments.remittanceFactsIn(tx, paymentId);
    if (remittance === null || remittance.id !== payload['remittanceId']) return false;
    const supplier = (await this.refs.partyAddressesIn(tx, 'SUPPLIER', [remittance.supplierId])).get(remittance.supplierId);
    if (supplier === undefined) return false;
    return this.queue.queueIn(tx, {
      event,
      code: 'REMITTANCE_ADVICE',
      recipient: { kind: 'SUPPLIER', supplierId: remittance.supplierId, branchId: remittance.branchId },
      data: { supplierName: supplier.name, amount: formatCedis(remittance.amountPesewas), paidOn: toBusinessDate(remittance.paidAt) },
      recordId: remittance.id,
      linkRecordId: remittance.id,
      oncePerRecord: true,
    });
  }
}
