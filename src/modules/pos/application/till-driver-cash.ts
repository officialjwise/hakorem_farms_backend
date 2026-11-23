import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { UnitOfWork } from '../../../platform/database/unit-of-work';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { DriverCashHolderView, DriverCashReconciliations, DriverCashReconciliationView } from '../../del';
import type { OwnOpenShift } from './own-open-shift';

/** The contract's `DriverCashHandInCreate`. */
export interface DriverCashHandInRequest {
  readonly driverId: string;
  readonly declaredPesewas: bigint;
  readonly note?: string | undefined;
}

/**
 * `handInDriverCash` (CR-057; the owner, 2026-11-23: a driver's cash is handed in once at a till shift, never typed in
 * as loose cash; ADR-0077, ADR-0092): the cashier counts a driver's cash on delivery into their own open shift, from an
 * enrolled device of that till, judged by the same shift check as an invoice paid at the till (`OwnOpenShift`, the
 * till's one deciding function `tillTakesCash`). DEL's `receiveIn` then hands in every collection the driver still
 * holds at the branch, once each, puts what was counted onto the shift through PAY's `DriverCash.handInIn` (so the X
 * and Z reports and the close count it) and records a short or over count as the driver's variance. Its own
 * permission is the counter's (`pos.sale.create`, A-285 (h)); the cashier is never the driver.
 */
export class TillDriverCash {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ownShift: OwnOpenShift,
    private readonly cash: DriverCashReconciliations,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
  ) {}

  handIn(actor: Actor | undefined, shiftId: string, body: DriverCashHandInRequest, idempotencyKey: string, deviceCredential: string | undefined): Promise<StoredResponse<DriverCashReconciliationView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const { shift, register } = await this.ownShift.lockIn(tx, actor, shiftId, deviceCredential);
      const request = { shiftId, driverId: body.driverId, declaredPesewas: body.declaredPesewas.toString(), note: body.note ?? null };
      const claim = await this.idempotency.claim(tx, { operationId: 'handInDriverCash', principalId: actor!.principalId, key: idempotencyKey, request });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<DriverCashReconciliationView>;
      this.ownShift.takesCashIn(shift);

      const view = await this.cash.receiveIn(tx, actor!, {
        branchId: register.branchId,
        shiftDocumentId: shift.id,
        register: { id: register.id, code: register.code },
        driverId: body.driverId,
        declaredPesewas: body.declaredPesewas,
        note: body.note ?? null,
      });
      await this.audit.record(tx, { module: 'pos', action: 'RECEIVE_DRIVER_CASH', entityType: 'Shift', entityId: shift.id, branchId: register.branchId, before: null, after: { ...view } });
      const response: StoredResponse<DriverCashReconciliationView> = { status: 201, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * `listShiftDriverCashHolders` (CR-063, added by B11 continued 6 with the parent session's leave): who the cashier
   * can take a driver's cash from, on the same shift check as the hand-in (the shift's own cashier, an enrolled device
   * of its till, 404 for an unknown shift, 422 `SHIFT_NOT_OPEN` once it stops taking cash). DEL lists each driver holding
   * a collection at the shift's branch not yet handed in, and how many; never an amount (a blind count). The caller is
   * left out: the cashier is never the driver.
   */
  holders(actor: Actor | undefined, shiftId: string, deviceCredential: string | undefined): Promise<{ readonly data: readonly DriverCashHolderView[] }> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const { shift, register } = await this.ownShift.lockIn(tx, actor, shiftId, deviceCredential);
      this.ownShift.takesCashIn(shift);
      const data = (await this.cash.holdersIn(tx, register.branchId)).filter((h) => h.driver.id !== actor!.principalId);
      return { data };
    });
  }
}
