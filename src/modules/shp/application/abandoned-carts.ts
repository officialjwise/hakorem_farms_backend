import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { MasterDataRefs } from '../../mdm';
import type { CartAbandoned } from '../events';
import type { ShpStore } from './shp-store';

export const CART_ABANDONED = 'shp.CartAbandoned';
/** A cart is reminded once it has been idle this long (FR-SHP-015: two hours, not checked out). */
export const CART_IDLE_MS = 2 * 3_600_000;
/** Carts one pass reminds; the rest wait for the next pass. */
export const ABANDONED_CART_BATCH = 200;

/**
 * The abandoned-cart sweep (FR-SHP-015, ADR-0026's assignment to B11; B11 continued 12, A-378), run by the worker as
 * the Scheduler. A cart a customer holds, with lines, idle two hours and not checked out, whose customer has given
 * marketing consent (`mdm.customer.marketing_consent_at`, read through MDM), gets one reminder requested, once ever
 * (`shp.abandoned_cart_notice`, `uq_abandoned_cart_notice`), and `shp.CartAbandoned` names only the cart and its
 * customer: never its lines. A guest's cart is never reminded (a guest has given no consent). The cart is not reserved
 * and keeps its status. NTF sends the message as marketing: opt-outs, quiet hours and consent again at send.
 */
export class AbandonedCarts {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: ShpStore,
    private readonly refs: MasterDataRefs,
    private readonly events: DomainEvents,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /**
   * Whether a reminded cart may still be messaged, read by NTF's sender just before it sends (B11 continued 12): still
   * ACTIVE with a line, so a cart checked out or converted to an order since the sweep gets nothing. Answers `''` (the
   * cart's link carries no token) or null.
   */
  async remindableIn(tx: Transaction, cartId: string): Promise<'' | null> {
    return (await this.store.remindableCart(tx, cartId)) ? '' : null;
  }

  /** One pass; answers the carts reminded. Running twice reminds each cart once. */
  async run(system: { readonly kind: 'SYSTEM'; readonly principalId: string }): Promise<string[]> {
    if (system.kind !== 'SYSTEM') throw new Error('the abandoned-cart sweep runs as a SYSTEM principal only');
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const at = this.clock.now();
      const idle = await this.store.idleCustomerCarts(tx, new Date(at.getTime() - CART_IDLE_MS), ABANDONED_CART_BATCH);
      const consenting = await this.refs.marketingConsentsIn(tx, idle.map((c) => c.customerId));
      const reminded: string[] = [];
      for (const cart of idle) {
        if (!consenting.has(cart.customerId)) continue;
        const noticeId = this.nextId();
        if (!(await this.store.insertAbandonedCartNotice(tx, { id: noticeId, cartId: cart.cartId, idleSince: cart.idleSince, at, actorId: system.principalId }))) continue;
        await this.events.publish<CartAbandoned>(tx, {
          type: CART_ABANDONED,
          subjectType: 'Cart',
          subjectId: cart.cartId,
          branchId: cart.branchId,
          payload: { cartId: cart.cartId, customerId: cart.customerId, noticeId, idleSince: cart.idleSince.toISOString() },
          occurredAt: at,
        });
        reminded.push(cart.cartId);
      }
      return reminded;
    });
  }
}
