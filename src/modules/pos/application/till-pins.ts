import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Settings } from '../../../platform/settings/settings';
import type { Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import { CLOCK_TOLERANCE_SECONDS, CLOCK_TOLERANCE_SETTING, isUuidV7 } from '../domain/client-time';
import { judgePinApproval, judgePinVerifier, judgeSignOut, pinEventAnswer, pinLocked, PIN_MAX_WRONG_TRIES, type PinApprovalVerdict } from '../domain/till-pin';
import type { TillPinFlagged } from '../events';
import type { Devices } from './devices';
import { TillPinInvalidError } from './errors';
import { pinKey, type PinEventOutcome, type PinEventPurpose, type PinStore, type TillPinRecord } from './pin-store';
import type { RegisterRecord, TillStore } from './till-store';

const SET = 'pos.pin.set';
/** Who runs a till: the operator whose verifier an enrolled till is issued, and who reports its PIN tries. */
const SELL = 'pos.sale.create';
/** The supervisor's permission: whose verifiers a till holds, who approves on it, witnesses a drop or signs a cashier out. */
export const SUPERVISE = 'pos.shift.close.approve';
export const TILL_PIN_FLAGGED = 'pos.TillPinFlagged';
/** Abuse case 35 (THREAT_MODEL section 4): a till PIN guessed, or a supervisor's PIN used for what they did not approve. */
export const ABUSE_TILL_PIN = 35;
const MILLISECONDS_PER_SECOND = 1_000;

export interface TillPinSet {
  readonly algorithm: string;
  readonly iterations: number;
  readonly pinSalt: string;
  readonly pinHash: string;
}

/** `TillPinStatus`: what a person's PIN is, never what it is made of. */
export interface TillPinStatusView {
  readonly principal: PrincipalRef;
  readonly version: number;
  readonly algorithm: string;
  readonly iterations: number;
  readonly setAt: string;
  readonly wrongTries: number;
  readonly locked: boolean;
}

/** `TillPinVerifier`: what an enrolled till holds to check a PIN offline (CR-032 point 1); a locked one carries no material. */
export interface TillPinVerifierView {
  readonly principal: PrincipalRef;
  readonly role: 'OPERATOR' | 'SUPERVISOR';
  readonly version: number;
  readonly algorithm: string;
  readonly iterations: number;
  readonly pinSalt: string | null;
  readonly pinHash: string | null;
  readonly wrongTries: number;
  readonly locked: boolean;
  /** The person's own price override limit per line at the branch, which bounds what their PIN approves offline (never unlimited). */
  readonly priceOverrideLimitPerLinePesewas: number;
}

export interface TillPinVerifierListView {
  readonly registerId: string;
  readonly data: readonly TillPinVerifierView[];
  readonly policy: { readonly maxWrongTries: number; readonly lockedUntil: 'NEW_PIN_SET' };
  readonly asOf: string;
}

export interface TillPinEventInput {
  readonly id: string;
  readonly principalId: string;
  readonly pinVersion: number;
  readonly outcome: PinEventOutcome;
  readonly purpose: PinEventPurpose;
  readonly occurredAt: Date;
}

export interface TillSignOutInput {
  readonly id: string;
  readonly cashierId: string;
  readonly shiftId?: string | undefined;
  readonly supervisorId: string;
  readonly supervisorPinVersion: number;
  readonly occurredAt: Date;
}

export interface TillPinReport {
  readonly events: readonly TillPinEventInput[];
  readonly signOuts?: readonly TillSignOutInput[] | undefined;
}

export interface TillPinReportItemView {
  readonly id: string;
  readonly outcome: 'APPLIED' | 'DUPLICATE' | 'REJECTED';
  readonly reason: string | null;
}

export interface TillPinReportResultView {
  readonly eventResults: readonly TillPinReportItemView[];
  readonly signOutResults: readonly TillPinReportItemView[];
  /** Whose PIN is locked now, of the people the report named. */
  readonly locked: readonly PrincipalRef[];
  readonly serverTime: string;
}

/**
 * The till PIN (CR-032, ADR-0080): a person sets their own PIN as the verifier the till derived from it; an enrolled
 * till is issued the verifiers it checks a PIN against offline; tills report every try, counted once by its client id,
 * and five wrong tries lock a PIN until its owner sets a new one; a locked cashier is signed out by a supervisor's PIN.
 * No operation takes a PIN, and a PIN authenticates nothing on the server: the staff session and the device credential
 * stay the server's controls (CR-032 points 2 and 5).
 */
export class TillPins {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly pins: PinStore,
    private readonly store: TillStore,
    private readonly devices: Devices,
    private readonly authoriser: Authoriser,
    private readonly principals: PrincipalNames,
    private readonly idempotency: Idempotency,
    private readonly settings: Settings,
    private readonly events: DomainEvents,
    private readonly audit: AuditTrail,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** `setTillPin`: one's own PIN, as a verifier no weaker than the owner's rules; the next version replaces the last. */
  set(actor: Actor | undefined, body: TillPinSet, idempotencyKey: string): Promise<StoredResponse<TillPinStatusView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, SET);
      const principalId = actor!.principalId;
      const claim = await this.idempotency.claim(tx, { operationId: 'setTillPin', principalId, key: idempotencyKey, request: { ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<TillPinStatusView>;
      const salt = Buffer.from(body.pinSalt, 'base64');
      const hash = Buffer.from(body.pinHash, 'base64');
      const broken = judgePinVerifier({ algorithm: body.algorithm, iterations: body.iterations, salt, hash });
      if (broken.length > 0) throw new TillPinInvalidError(broken);
      if (await this.pins.saltUsed(tx, salt)) throw new TillPinInvalidError([{ field: '/pinSalt', rule: 'PIN_SALT_REUSED' }]);
      const [previous] = await this.pins.latestPins(tx, [principalId]);
      const now = this.clock.now();
      const record = { id: this.nextId(), principalId, version: (previous?.version ?? 0) + 1, algorithm: body.algorithm, iterations: body.iterations, salt, hash, setAt: now, recordedAt: now };
      await this.pins.insertPin(tx, record);
      const view = await this.statusView(tx, { ...record, supersededAt: null }, 0);
      // The audit names the version and its cost, never the salt or the hash.
      await this.audit.record(tx, {
        module: 'pos',
        action: 'SET_TILL_PIN',
        entityType: 'TillPin',
        entityId: record.id,
        before: previous === undefined ? null : { version: previous.version, iterations: previous.iterations },
        after: { version: record.version, algorithm: record.algorithm, iterations: record.iterations },
      });
      const response: StoredResponse<TillPinStatusView> = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * `listTillPinVerifiers`: for an enrolled till of the branch, the caller's verifier and every supervisor's at the
   * branch, so the till can unlock and take approvals offline (CR-032 point 1). Each issue is audited with whose versions
   * were issued, never their material.
   */
  verifiers(actor: Actor | undefined, registerId: string, deviceCredential: string | undefined): Promise<TillPinVerifierListView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const register = await this.registerIn(tx, actor, registerId);
      const device = await this.devices.deviceOfIn(tx, deviceCredential, register.id);
      const supervisors = await this.authoriser.holdersIn(tx, SUPERVISE, register.branchId);
      const people = [...new Set([actor!.principalId, ...supervisors])];
      const latest = await this.pins.latestPins(tx, people);
      const tries = await this.pins.wrongTriesOf(tx, latest.map((p) => ({ principalId: p.principalId, version: p.version })));
      const names = await this.principals.refs(tx, latest.map((p) => p.principalId));
      const limits = new Map<string, bigint>();
      for (const p of latest) limits.set(p.principalId, await this.authoriser.limitIn(tx, staffActor(p.principalId), 'PRICE_OVERRIDE_PER_LINE', register.branchId));
      const data = latest.map((p): TillPinVerifierView => {
        const wrongTries = tries.get(pinKey(p.principalId, p.version)) ?? 0;
        const locked = pinLocked(wrongTries);
        return {
          principal: names.get(p.principalId) ?? { id: p.principalId, displayName: 'Unknown' },
          role: supervisors.includes(p.principalId) ? 'SUPERVISOR' : 'OPERATOR',
          version: p.version,
          algorithm: p.algorithm,
          iterations: p.iterations,
          pinSalt: locked ? null : p.salt.toString('base64'),
          pinHash: locked ? null : p.hash.toString('base64'),
          wrongTries,
          locked,
          priceOverrideLimitPerLinePesewas: Number(limits.get(p.principalId) ?? 0n),
        };
      });
      const now = this.clock.now();
      await this.audit.record(tx, {
        module: 'pos',
        action: 'ISSUE_TILL_PIN_VERIFIERS',
        entityType: 'Register',
        entityId: register.id,
        branchId: register.branchId,
        before: null,
        after: { deviceId: device.id, issued: data.map((v) => ({ principalId: v.principal.id, version: v.version, locked: v.locked })) },
      });
      return { registerId: register.id, data, policy: { maxWrongTries: PIN_MAX_WRONG_TRIES, lockedUntil: 'NEW_PIN_SET' }, asOf: now.toISOString() };
    });
  }

  /**
   * `reportTillPinEvents`: every PIN try a till made, online at once or at sync for those made offline, each counted
   * once by its client id (CR-032 point 3); the fifth wrong try against a version locks it and is raised once. Then the
   * locked cashiers it signed out with a supervisor's PIN, each once by its client id, never by the cashier, and only
   * once the server holds the cashier locked. A refusal is answered with its reason and raised.
   */
  report(actor: Actor | undefined, registerId: string, body: TillPinReport, deviceCredential: string | undefined): Promise<TillPinReportResultView> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const register = await this.registerIn(tx, actor, registerId);
      const device = await this.devices.deviceOfIn(tx, deviceCredential, register.id);
      const now = this.clock.now();
      const tolerance = (await this.settings.integer(CLOCK_TOLERANCE_SETTING, CLOCK_TOLERANCE_SECONDS)) * MILLISECONDS_PER_SECOND;
      const tillTime = (t: Date): Date => (t.getTime() - now.getTime() > tolerance ? now : t);
      const base = { register, deviceId: device.id, now };
      const eventResults: TillPinReportItemView[] = [];
      const named = new Set<string>();
      for (const e of [...body.events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id))) {
        named.add(e.principalId);
        eventResults.push(await this.applyEvent(tx, base, actor!, { ...e, occurredAt: tillTime(e.occurredAt) }, e));
      }
      const signOutResults: TillPinReportItemView[] = [];
      for (const s of body.signOuts ?? []) {
        named.add(s.cashierId);
        signOutResults.push(await this.applySignOut(tx, base, actor!, { ...s, occurredAt: tillTime(s.occurredAt) }, s));
      }
      const latest = await this.pins.latestPins(tx, [...named]);
      const tries = await this.pins.wrongTriesOf(tx, latest.map((p) => ({ principalId: p.principalId, version: p.version })));
      const lockedIds = latest.filter((p) => pinLocked(tries.get(pinKey(p.principalId, p.version)) ?? 0)).map((p) => p.principalId);
      const names = await this.principals.refs(tx, lockedIds);
      const ref = (id: string): PrincipalRef => names.get(id) ?? { id, displayName: 'Unknown' };
      return { eventResults, signOutResults: [...signOutResults].sort((a, b) => a.id.localeCompare(b.id)), locked: lockedIds.map(ref), serverTime: now.toISOString() };
    });
  }

  /**
   * Whether an approval given with a PIN on the till stands (CR-032 point 4): read by `recordCashMovement` for a drop's
   * witness and by the sync for a queued drop's witness and an unverified tender's approver.
   */
  async approvalIn(tx: Transaction, f: { readonly approverId: string; readonly pinVersion: number | null; readonly cashierId: string; readonly actorId: string | null; readonly branchId: string; readonly at: Date }): Promise<PinApprovalVerdict> {
    const isSupervisor = await this.supervisesAt(tx, f.approverId, f.branchId);
    const pin = f.pinVersion === null ? null : await this.pins.pinVersion(tx, f.approverId, f.pinVersion);
    const wrong = pin === null ? 0 : await this.pins.wrongTries(tx, pin.principalId, pin.version, f.at);
    return judgePinApproval({
      approverId: f.approverId,
      pinVersion: f.pinVersion,
      cashierId: f.cashierId,
      actorId: f.actorId,
      approverIsSupervisor: isSupervisor,
      verifier: pin === null ? null : { version: pin.version, supersededAt: pin.supersededAt, wrongTriesBefore: wrong },
      at: f.at,
    });
  }

  private async applyEvent(
    tx: Transaction,
    base: { readonly register: RegisterRecord; readonly deviceId: string; readonly now: Date },
    actor: Actor,
    e: TillPinEventInput,
    sent: TillPinEventInput,
  ): Promise<TillPinReportItemView> {
    const { register, deviceId, now } = base;
    const prior = await this.pins.eventById(tx, e.id);
    const answer = pinEventAnswer(
      prior === null
        ? null
        : { sameContent: prior.principalId === sent.principalId && prior.pinVersion === sent.pinVersion && prior.outcome === sent.outcome && prior.purpose === sent.purpose && prior.deviceId === deviceId },
    );
    if (answer === 'DUPLICATE') return { id: e.id, outcome: 'DUPLICATE', reason: null };
    const refuse = async (reason: string): Promise<TillPinReportItemView> => {
      await this.raise(tx, register, deviceId, now, {
        subjectId: e.id,
        principalId: e.principalId,
        pinVersion: e.pinVersion,
        exceptionKind: 'TILL_PIN_REPORT_REJECTED',
        severity: 'URGENT',
        summary: `A PIN try from till ${register.code} was refused: ${reason}`,
        occurredAt: e.occurredAt.toISOString(),
        claim: { id: e.id, principalId: e.principalId, pinVersion: e.pinVersion, outcome: e.outcome, purpose: e.purpose },
        fact: { reason },
      });
      return { id: e.id, outcome: 'REJECTED', reason };
    };
    if (answer === 'ID_REUSED_WITH_OTHER_CONTENT') return refuse('ID_REUSED_WITH_OTHER_CONTENT');
    if (!isUuidV7(e.id)) return refuse('ID_NOT_UUID_V7');
    const pin = await this.pins.pinVersion(tx, e.principalId, e.pinVersion);
    if (pin === null) return refuse('PIN_UNKNOWN');
    const before = await this.pins.wrongTries(tx, e.principalId, e.pinVersion, null);
    await this.pins.insertEvent(tx, { id: e.id, registerId: register.id, deviceId, branchId: register.branchId, principalId: e.principalId, pinVersion: e.pinVersion, outcome: e.outcome, purpose: e.purpose, occurredAt: e.occurredAt, receivedAt: now, recordedAt: now, actorId: actor.principalId });
    if (e.outcome === 'FAILED' && !pinLocked(before) && pinLocked(before + 1)) {
      await this.raise(tx, register, deviceId, now, {
        subjectId: e.id,
        principalId: e.principalId,
        pinVersion: e.pinVersion,
        exceptionKind: 'TILL_PIN_LOCKED',
        severity: 'URGENT',
        summary: `A till PIN was locked after ${PIN_MAX_WRONG_TRIES} wrong tries on till ${register.code}`,
        occurredAt: e.occurredAt.toISOString(),
        claim: { purpose: e.purpose },
        fact: { wrongTries: before + 1 },
      });
    }
    return { id: e.id, outcome: 'APPLIED', reason: null };
  }

  private async applySignOut(
    tx: Transaction,
    base: { readonly register: RegisterRecord; readonly deviceId: string; readonly now: Date },
    actor: Actor,
    s: TillSignOutInput,
    sent: TillSignOutInput,
  ): Promise<TillPinReportItemView> {
    const { register, deviceId, now } = base;
    const prior = await this.pins.signOutById(tx, s.id);
    const answer = pinEventAnswer(
      prior === null ? null : { sameContent: prior.cashierId === sent.cashierId && prior.supervisorId === sent.supervisorId && prior.supervisorPinVersion === sent.supervisorPinVersion && prior.deviceId === deviceId },
    );
    if (answer === 'DUPLICATE') return { id: s.id, outcome: 'DUPLICATE', reason: null };
    const claim = { id: s.id, cashierId: s.cashierId, supervisorId: s.supervisorId, supervisorPinVersion: s.supervisorPinVersion, shiftId: s.shiftId ?? null };
    const refuse = async (reason: string): Promise<TillPinReportItemView> => {
      await this.raise(tx, register, deviceId, now, {
        subjectId: s.id,
        principalId: s.cashierId,
        pinVersion: null,
        supervisorId: s.supervisorId,
        shiftId: s.shiftId ?? null,
        exceptionKind: 'TILL_PIN_REPORT_REJECTED',
        severity: 'URGENT',
        summary: `A locked cashier's sign-out from till ${register.code} was refused: ${reason}`,
        occurredAt: s.occurredAt.toISOString(),
        claim,
        fact: { reason },
      });
      return { id: s.id, outcome: 'REJECTED', reason };
    };
    if (answer === 'ID_REUSED_WITH_OTHER_CONTENT') return refuse('ID_REUSED_WITH_OTHER_CONTENT');
    if (!isUuidV7(s.id)) return refuse('ID_NOT_UUID_V7');
    if (s.shiftId !== undefined) {
      const [shift] = await this.store.shifts(tx, [s.shiftId]);
      if (shift === undefined || shift.registerId !== register.id || shift.cashierId !== s.cashierId) return refuse('SHIFT_NOT_OF_TILL_AND_CASHIER');
    }
    const [cashierPin] = await this.pins.latestPins(tx, [s.cashierId]);
    const cashierLocked = cashierPin !== undefined && pinLocked(await this.pins.wrongTries(tx, s.cashierId, cashierPin.version, null));
    const supervisorPin = await this.approvalIn(tx, { approverId: s.supervisorId, pinVersion: s.supervisorPinVersion, cashierId: s.cashierId, actorId: null, branchId: register.branchId, at: s.occurredAt });
    const supervisorIsSupervisor = await this.supervisesAt(tx, s.supervisorId, register.branchId);
    const broken = judgeSignOut({ cashierId: s.cashierId, supervisorId: s.supervisorId, supervisorIsSupervisor, cashierLocked, supervisorPin });
    if (broken.length > 0) return refuse(broken[0]!);
    await this.pins.insertSignOut(tx, {
      id: s.id,
      registerId: register.id,
      deviceId,
      branchId: register.branchId,
      shiftId: s.shiftId ?? null,
      cashierId: s.cashierId,
      supervisorId: s.supervisorId,
      supervisorPinVersion: s.supervisorPinVersion,
      occurredAt: s.occurredAt,
      receivedAt: now,
      recordedAt: now,
      actorId: actor.principalId,
    });
    await this.audit.record(tx, { module: 'pos', action: 'SIGN_OUT_LOCKED_CASHIER', entityType: 'TillSignOut', entityId: s.id, branchId: register.branchId, before: null, after: { ...claim, deviceId, registerId: register.id, occurredAt: s.occurredAt.toISOString() } });
    await this.raise(tx, register, deviceId, now, {
      subjectId: s.id,
      principalId: s.cashierId,
      pinVersion: cashierPin!.version,
      supervisorId: s.supervisorId,
      shiftId: s.shiftId ?? null,
      exceptionKind: 'LOCKED_CASHIER_SIGNED_OUT',
      severity: 'REVIEW',
      summary: `A cashier locked out of till ${register.code} was signed out by a supervisor's PIN`,
      occurredAt: s.occurredAt.toISOString(),
      claim,
      fact: { cashierLocked: true, supervisorPinVersion: s.supervisorPinVersion },
    });
    return { id: s.id, outcome: 'APPLIED', reason: null };
  }

  private async raise(
    tx: Transaction,
    register: RegisterRecord,
    deviceId: string,
    now: Date,
    flag: Omit<TillPinFlagged, 'branchId' | 'register' | 'deviceId' | 'recordedAt' | 'abuseCases'>,
  ): Promise<void> {
    const payload: TillPinFlagged = { ...flag, branchId: register.branchId, register: { id: register.id, code: register.code }, deviceId, recordedAt: now.toISOString(), abuseCases: [ABUSE_TILL_PIN] };
    await this.events.publish(tx, { type: TILL_PIN_FLAGGED, subjectType: 'TillPin', subjectId: flag.subjectId, branchId: register.branchId, payload, occurredAt: now });
  }

  /** Whether a principal supervises at the branch now, read by id as the caller's grants would be; it refuses nothing. */
  private async supervisesAt(tx: Transaction, principalId: string, branchId: string): Promise<boolean> {
    return (await this.authoriser.scopes(tx, staffActor(principalId), SUPERVISE)).some((g) => g.branchId === branchId);
  }

  private async registerIn(tx: Transaction, actor: Actor | undefined, registerId: string): Promise<RegisterRecord> {
    const [register] = await this.store.registers(tx, [registerId]);
    await this.authoriser.authorise(tx, actor, SELL, register === undefined ? {} : { branchId: register.branchId, locationId: register.locationId });
    if (register === undefined) throw new NotFoundError(`no register ${registerId}`);
    return register;
  }

  private async statusView(tx: Transaction, pin: TillPinRecord, wrongTries: number): Promise<TillPinStatusView> {
    const names = await this.principals.refs(tx, [pin.principalId]);
    return {
      principal: names.get(pin.principalId) ?? { id: pin.principalId, displayName: 'Unknown' },
      version: pin.version,
      algorithm: pin.algorithm,
      iterations: pin.iterations,
      setAt: pin.setAt.toISOString(),
      wrongTries,
      locked: pinLocked(wrongTries),
    };
  }
}

/** A principal read by id for their grants and limits, as the caller's would be; it is not the caller. */
function staffActor(principalId: string): Actor {
  return { principalId, kind: 'USER', displayName: '', realm: 'STAFF', sessionId: null, steppedUpAt: null };
}
