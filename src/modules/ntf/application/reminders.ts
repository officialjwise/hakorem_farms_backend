import type { Transaction } from '../../../platform/database/unit-of-work';
import type { AsyncConsumer, EventEnvelope } from '../../../platform/events/domain-events';
import type { StockUnits } from '../../inv';
import type { MortalityRecords } from '../../liv';
import type { MasterDataRefs } from '../../mdm';
import type { Dunning } from '../../whl';
import { mortalityReturnedOf, reminderMessageOf } from '../domain/messages';
import type { Channel } from '../domain/templates';
import type { MessageQueue } from './message-queue';

/**
 * Payment reminders (FR-WHL-011, FR-NTF-005, FR-NTF-006; B11 continued 11, A-376): NTF's consumer of
 * `whl.DunningNoticeDue`. The reminder is written from the notice as WHL holds it (`Dunning.noticesIn`: the customer, the
 * branch, the level's template and channels, the figures), never from the event's copy, and goes to the customer's own
 * number read through MDM, by the level's channels the trigger allows. A REMINDER: an opted-out number or a channel the
 * customer turned off suppresses it, and quiet hours delay it to 07:00 Africa/Accra (`MessageQueue`).
 */
export class Reminders {
  constructor(
    private readonly queue: MessageQueue,
    private readonly dunning: Dunning,
    private readonly refs: MasterDataRefs,
  ) {}

  readonly consumer: AsyncConsumer = {
    name: 'ntf.reminders',
    eventTypes: ['whl.DunningNoticeDue'],
    isolation: 'serializable',
    handle: async (tx, event) => {
      await this.queueIn(tx, event);
    },
  };

  async queueIn(tx: Transaction, event: EventEnvelope): Promise<boolean> {
    const noticeId = (event.payload as Readonly<Record<string, unknown>>)['noticeId'];
    if (typeof noticeId !== 'string') return false;
    const notice = (await this.dunning.noticesIn(tx, [noticeId])).get(noticeId);
    if (notice === undefined) return false;
    const customer = (await this.refs.customerContactsIn(tx, [notice.customerId])).get(notice.customerId);
    if (customer === undefined) return false;
    const message = reminderMessageOf(notice, customer.name);
    if (message === null) return false;
    return this.queue.queueIn(tx, {
      event,
      code: message.code,
      recipient: { kind: 'CUSTOMER', customerId: notice.customerId, branchId: notice.branchId },
      data: message.data,
      recordId: notice.id,
      allowedChannels: notice.channels as readonly Channel[],
    });
  }
}

/**
 * The console's notifications to staff (FR-NTF-008; B11 continued 11): a death report the malware scan sent back
 * (`liv.MortalityReturned`, B06r, A-175) reaches its own reporter, read from LIV's record, never the event's copy, with
 * the animal's tag read through INV. OPERATIONAL: never suppressed, never delayed.
 */
export class StaffNotifications {
  constructor(
    private readonly queue: MessageQueue,
    private readonly mortality: MortalityRecords,
    private readonly units: StockUnits,
  ) {}

  readonly consumer: AsyncConsumer = {
    name: 'ntf.staff-notifications',
    eventTypes: ['liv.MortalityReturned'],
    isolation: 'serializable',
    handle: async (tx, event) => {
      await this.queueIn(tx, event);
    },
  };

  async queueIn(tx: Transaction, event: EventEnvelope): Promise<boolean> {
    const recordId = (event.payload as Readonly<Record<string, unknown>>)['mortalityRecordId'];
    if (typeof recordId !== 'string') return false;
    const record = await this.mortality.returnFactsIn(tx, recordId);
    if (record?.status !== 'RETURNED') return false;
    const unit = (await this.units.factsIn(tx, [record.stockUnitId], event.occurredAt)).get(record.stockUnitId);
    const message = mortalityReturnedOf(record.returnedReason, unit?.identifier ?? '');
    return this.queue.queueIn(tx, {
      event,
      code: message.code,
      recipient: { kind: 'PRINCIPAL', principalId: record.reportedBy, branchId: record.branchId },
      data: message.data,
      recordId: record.id,
      linkPath: `/livestock/mortality/${record.id}`,
    });
  }
}
