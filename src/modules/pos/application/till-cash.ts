import type { Actor } from '../../../platform/context/request-context';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { Authoriser } from '../../iam';
import type { TillCashAnswer, TillCashRequest, TillShiftCheck } from '../../pay';
import { judgeLateTillCash, judgeTillCash } from '../domain/till';
import type { TillStore } from './till-store';

/** Who may record cash on another cashier's shift: the manager recovering a till (OFFLINE_SYNC 6.5, A-273 (f)). */
export const RECOVER_ANY_SHIFT = 'pos.shift.force_close';

/**
 * POS's answer to PAY's `TillShiftCheck` (ADR-0077): before any cash moves into or out of a till through PAY, whoever
 * calls PAY, the shift is locked and must be a till shift, OPEN (a CLOSING, CLOSED or force-closed shift takes and pays
 * out nothing), of the till and branch named, and the actor's own unless they hold `pos.shift.force_close` at its branch.
 * A document that is no shift of POS's is not answered, so the registry refuses it.
 */
export class TillCash implements TillShiftCheck {
  constructor(
    private readonly store: TillStore,
    private readonly authoriser: Authoriser,
  ) {}

  async cashAtIn(tx: Transaction, request: TillCashRequest): Promise<TillCashAnswer | null> {
    const shift = await this.store.lockShift(tx, request.shiftDocumentId);
    if (shift === null) return null;
    const register = (await this.store.registers(tx, [shift.registerId]))[0]!;
    // A late entry from the till's queue: onto the shift it happened in once that shift has closed, by its own cashier
    // only (ADR-0077 Amendments, the owner on 2026-11-18). Anything else is judged as any cash is: only while OPEN.
    if (request.lateEntry === true) {
      const late = judgeLateTillCash(
        { status: shift.status, registerId: shift.registerId, branchId: shift.branchId, cashierId: shift.cashierId },
        { registerId: request.registerId, branchId: request.branchId, actorId: request.actorId, direction: request.direction },
      );
      return late.ok ? { ok: true, register: { id: register.id, code: register.code, locationId: register.locationId } } : { ok: false, refusal: late.error };
    }
    const recovers = request.actorId !== shift.cashierId && (await this.holdsAt(tx, request.actorId, RECOVER_ANY_SHIFT, shift.branchId));
    const judged = judgeTillCash(
      { status: shift.status, registerId: shift.registerId, branchId: shift.branchId, cashierId: shift.cashierId },
      { registerId: request.registerId, branchId: request.branchId, actorId: request.actorId, actorRecoversAnyShift: recovers },
    );
    return judged.ok ? { ok: true, register: { id: register.id, code: register.code, locationId: register.locationId } } : { ok: false, refusal: judged.error };
  }

  /** Whether a principal holds a permission at the branch now; they are not the caller, so nothing is refused or audited. */
  private async holdsAt(tx: Transaction, principalId: string, permission: string, branchId: string): Promise<boolean> {
    const holder: Actor = { principalId, kind: 'USER', displayName: '', realm: 'STAFF', sessionId: null, steppedUpAt: null };
    return (await this.authoriser.scopes(tx, holder, permission)).some((s) => s.branchId === branchId);
  }
}
