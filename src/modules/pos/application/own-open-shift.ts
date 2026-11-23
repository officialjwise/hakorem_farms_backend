import type { Actor } from '../../../platform/context/request-context';
import type { Transaction } from '../../../platform/database/unit-of-work';
import { ForbiddenError, NotFoundError } from '../../../platform/errors/api-error';
import type { Authoriser } from '../../iam';
import { tillTakesCash } from '../domain/offline-sync';
import type { Devices } from './devices';
import { ShiftNotOpenError } from './errors';
import type { RegisterRecord, ShiftRecord, TillStore } from './till-store';

/** Taking money at the till on one's own open shift: the counter sale's permission (A-285 (h)). */
export const COLLECT_AT_TILL = 'pos.sale.create';

/**
 * The shift check of money taken at the till online (A-212 (a), A-285 (g), ADR-0077), shared by `payInvoiceAtTill` and
 * `handInDriverCash` so there is one: the shift locked, the caller authorised at its till, an unknown shift 404, the
 * cash only onto the caller's own shift (never another cashier's), from an enrolled device of that till. `takesCashIn`
 * then asks the till's one deciding function (`tillTakesCash`): only `ON_SHIFT` is taken online, a late entry is the
 * queue's alone (ADR-0077 Amendments).
 */
export class OwnOpenShift {
  constructor(
    private readonly store: TillStore,
    private readonly devices: Devices,
    private readonly authoriser: Authoriser,
  ) {}

  async lockIn(tx: Transaction, actor: Actor | undefined, shiftId: string, deviceCredential: string | undefined): Promise<{ readonly shift: ShiftRecord; readonly register: RegisterRecord }> {
    const shift = await this.store.lockShift(tx, shiftId);
    const register = shift === null ? null : (await this.store.registers(tx, [shift.registerId]))[0]!;
    await this.authoriser.authorise(tx, actor, COLLECT_AT_TILL, register === null ? {} : { branchId: register.branchId, locationId: register.locationId });
    if (shift === null || register === null) throw new NotFoundError(`no shift ${shiftId}`);
    // Cash goes only onto the cashier's own shift: nobody takes it on another cashier's (A-212 (a), ADR-0077).
    if (shift.cashierId !== actor!.principalId) throw new ForbiddenError(`${COLLECT_AT_TILL} refused: the shift is another cashier's`);
    await this.devices.deviceOfIn(tx, deviceCredential, register.id);
    return { shift, register };
  }

  takesCashIn(shift: ShiftRecord): void {
    if (tillTakesCash(shift) !== 'ON_SHIFT') throw new ShiftNotOpenError(shift.status);
  }
}
