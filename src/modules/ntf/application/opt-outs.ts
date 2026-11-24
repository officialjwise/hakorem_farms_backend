import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { Cursors } from '../../../platform/http/cursor';
import type { Authoriser } from '../../iam';
import { maskAddress } from '../domain/messages';
import type { ReplyInstruction } from '../domain/routing';
import type { AddressHasher } from './customer-messages';
import { MESSAGING_WEBHOOK_ACTOR } from './delivery-reports';
import type { NtfStore, OptOutRecord } from './ntf-store';
import type { Page } from './templates';

const READ = 'ntf.message.read';

/** The contract's `OptOut`. */
export interface OptOutView {
  readonly id: string;
  readonly addressMasked: string;
  readonly channel: string;
  readonly direction: 'OPT_OUT' | 'OPT_IN';
  readonly source: string;
  readonly recordedAt: string;
}

/**
 * Opt-outs (FR-NTF-005, B11 continued 11): every instruction a number sent, kept as its mask and keyed hash (an opt-out
 * outlives the customer record and is matched without the number), the newest instruction per channel being the
 * number's state. A STOP reply is recorded at once by the messaging webhook (`recordReplyIn`, in its transaction), so
 * the very next reminder to that number is suppressed. The list is read by holders of `ntf.message.read` at any branch:
 * a number is not a branch's (A-376 (f)).
 */
export class OptOuts {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: NtfStore,
    private readonly authoriser: Authoriser,
    private readonly hasher: AddressHasher,
    private readonly cursors: Cursors,
    clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<OptOutView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const binding = { operationId: 'listOptOuts', principalId: actor!.principalId, filters: {} };
      const at = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const found = await this.store.optOutPage(tx, at === null ? null : [new Date(at['recordedAt']!), at['id']!], limit + 1);
      const rows = found.slice(0, limit);
      const last = rows.at(-1);
      const hasMore = found.length > limit;
      return {
        data: rows.map(view),
        page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { recordedAt: last.recordedAt.toISOString(), id: last.id }) : null, limit, hasMore },
      };
    });
  }

  /** A signed STOP or START reply from a phone, in the webhook's transaction: the number's SMS instruction, recorded once. */
  async recordReplyIn(tx: Transaction, reply: { readonly providerReportId: string; readonly from: string; readonly instruction: ReplyInstruction; readonly at: Date }): Promise<void> {
    await this.store.insertOptOut(tx, {
      id: this.nextId(),
      addressHash: this.hasher.hash(reply.from),
      addressMasked: maskAddress(reply.from),
      channel: 'SMS',
      direction: reply.instruction,
      source: reply.instruction === 'OPT_OUT' ? 'REPLY_STOP' : 'REPLY_START',
      providerReportId: reply.providerReportId,
      occurredAt: reply.at,
      recordedAt: reply.at,
      actorId: MESSAGING_WEBHOOK_ACTOR.principalId,
    });
  }
}

function view(o: OptOutRecord): OptOutView {
  return { id: o.id, addressMasked: o.addressMasked, channel: o.channel, direction: o.direction, source: o.source, recordedAt: o.recordedAt.toISOString() };
}
