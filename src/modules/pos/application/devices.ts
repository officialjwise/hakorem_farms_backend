import { createHash, randomBytes } from 'node:crypto';
import { type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { ForbiddenError, NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import { DeviceCredentialInvalidError, DeviceCredentialShownOnceError, DeviceInvalidError, DeviceRevokedError } from './errors';
import { oneMore } from './paging';
import type { Page } from './shifts';
import type { DeviceRecord, RegisterRecord, TillStore } from './till-store';

const READ = 'pos.device.read';
const ENROL = 'pos.device.enrol';
/** 256 random bits (ADR-0016: a high-entropy string), written base64url without padding. */
const CREDENTIAL_BYTES = 32;
const CREDENTIAL_PREFIX = 'hkdev_';

/** The contract's `DeviceEnrolment`. The credential's hash is never shown. */
export interface DeviceView {
  readonly id: string;
  readonly registerId: string;
  readonly deviceLabel: string;
  readonly enrolledBy: PrincipalRef;
  readonly enrolledAt: string;
  readonly lastSyncAt: string | null;
  readonly revokedAt: string | null;
}

/** The contract's `DeviceEnrolled`: the credential, shown this once. */
export interface DeviceEnrolledView {
  readonly device: DeviceView;
  readonly deviceCredential: string;
}

/** The SHA-256 of a credential as the device sends it: the only form the server keeps (ADR-0016). */
export function credentialHash(credential: string): Buffer {
  return createHash('sha256').update(credential, 'utf8').digest();
}

/**
 * The devices that run a till (FR-POS-010, ADR-0016, A-274): a manager enrols one and its credential is shown once and
 * stored only as its hash; a lost or stolen device is revoked with a reason and sells and syncs nothing more. Every
 * handler authorises at the till's branch and location (deny by default); enrolment and revocation need a fresh step-up.
 */
export class Devices {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: TillStore,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
    private readonly nextId: () => string,
  ) {}

  /** `enrolDevice`: a new device on an active till, its credential in this answer only. */
  enrol(actor: Actor | undefined, registerId: string, body: { readonly deviceLabel: string }, idempotencyKey: string): Promise<StoredResponse<DeviceEnrolledView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const register = await this.store.lockRegister(tx, registerId);
      await this.authoriser.authorise(tx, actor, ENROL, scopeOf(register));
      if (register === null) throw new NotFoundError(`no register ${registerId}`);
      const claim = await this.idempotency.claim(tx, { operationId: 'enrolDevice', principalId: actor!.principalId, key: idempotencyKey, request: { registerId, ...body } });
      // The credential was shown once and is kept nowhere in the clear: a replay cannot show it again.
      if (claim.kind === 'REPLAY') throw new DeviceCredentialShownOnceError('the device was enrolled; its credential was shown once');
      if (register.status !== 'ACTIVE') throw new DeviceInvalidError([{ field: '/registerId', rule: 'REGISTER_RETIRED' }]);
      const id = this.nextId();
      const credential = `${CREDENTIAL_PREFIX}${register.code}.${randomBytes(CREDENTIAL_BYTES).toString('base64url')}`;
      await this.store.insertDevice(tx, { id, registerId, deviceLabel: body.deviceLabel, credentialHash: credentialHash(credential), branchId: register.branchId }, actor!.principalId, this.clock.now());
      const [view] = await this.views(tx, await this.store.devices(tx, [id]));
      await this.audit.record(tx, { module: 'pos', action: 'ENROL', entityType: 'DeviceEnrolment', entityId: id, branchId: register.branchId, before: null, after: { ...view! } });
      // The stored answer never holds the credential (A-274).
      await this.idempotency.complete(tx, claim.id, { status: 201, body: { device: view!, deviceCredential: null } });
      return { status: 201, body: { device: view!, deviceCredential: credential } };
    });
  }

  /** `listRegisterDevices`: every device enrolled on the till, revoked ones included, newest first. */
  list(actor: Actor | undefined, registerId: string, cursor: string | undefined, limit: number): Promise<Page<DeviceView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const [register] = await this.store.registers(tx, [registerId]);
      await this.authoriser.authorise(tx, actor, READ, scopeOf(register ?? null));
      if (register === undefined) throw new NotFoundError(`no register ${registerId}`);
      const binding = { operationId: 'listRegisterDevices', principalId: actor!.principalId, filters: { registerId } };
      const before = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const rows = await this.store.devicesOfRegister(tx, registerId, before, oneMore(limit));
      const kept = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      return { data: await this.views(tx, kept), page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: kept.at(-1)!.id }) : null, limit, hasMore } };
    });
  }

  /** `revokeDevice`: a lost or retired device stops at once; it is enrolled again as a new device if found. */
  revoke(actor: Actor | undefined, id: string, body: { readonly reason: string }, idempotencyKey: string): Promise<StoredResponse<DeviceView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const device = await this.store.lockDevice(tx, id);
      const register = device === null ? null : ((await this.store.registers(tx, [device.registerId]))[0] ?? null);
      await this.authoriser.authorise(tx, actor, ENROL, scopeOf(register));
      if (device === null) throw new NotFoundError(`no device ${id}`);
      const claim = await this.idempotency.claim(tx, { operationId: 'revokeDevice', principalId: actor!.principalId, key: idempotencyKey, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<DeviceView>;
      if (device.revokedAt !== null) throw new DeviceInvalidError([{ field: '', rule: 'DEVICE_ALREADY_REVOKED' }]);
      const [before] = await this.views(tx, [device]);
      await this.store.revokeDevice(tx, id, body.reason, actor!.principalId, this.clock.now());
      const [view] = await this.views(tx, await this.store.devices(tx, [id]));
      await this.audit.record(tx, { module: 'pos', action: 'REVOKE', entityType: 'DeviceEnrolment', entityId: id, branchId: device.branchId, before: { ...before! }, after: { ...view!, reason: body.reason } });
      const response: StoredResponse<DeviceView> = { status: 200, body: view! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * The device a request comes from, for an operation the contract secures with the device credential as well as the
   * staff session (docs/API.md section 3.9): 401 `DEVICE_CREDENTIAL_INVALID` when it is missing or unknown, 403
   * `DEVICE_REVOKED` when a manager revoked it, 403 `FORBIDDEN` when it is enrolled on another till. It authorises
   * nothing on its own: the handler has already checked the staff session's permission.
   */
  async deviceOfIn(tx: Transaction, credential: string | undefined, registerId: string): Promise<DeviceRecord> {
    if (credential === undefined || !credential.startsWith(CREDENTIAL_PREFIX)) throw new DeviceCredentialInvalidError('no device credential');
    const device = await this.store.deviceByCredential(tx, credentialHash(credential));
    if (device === null) throw new DeviceCredentialInvalidError('the device credential is unknown');
    if (device.revokedAt !== null) throw new DeviceRevokedError(`device ${device.id} was revoked`);
    if (device.registerId !== registerId) throw new ForbiddenError(`device ${device.id} is enrolled on another till`);
    return device;
  }

  private async views(tx: Transaction, devices: readonly DeviceRecord[]): Promise<DeviceView[]> {
    const names = await this.principals.refs(tx, [...new Set(devices.map((d) => d.enrolledBy))]);
    return devices.map((d) => ({
      id: d.id,
      registerId: d.registerId,
      deviceLabel: d.deviceLabel,
      enrolledBy: names.get(d.enrolledBy) ?? { id: d.enrolledBy, displayName: 'Unknown' },
      enrolledAt: d.enrolledAt.toISOString(),
      lastSyncAt: d.lastSyncAt?.toISOString() ?? null,
      revokedAt: d.revokedAt?.toISOString() ?? null,
    }));
  }
}

/** Where a till sells: its branch and location, which a grant to a location must cover (ADR-0017). */
function scopeOf(register: RegisterRecord | null): { branchId?: string; locationId?: string } {
  return register === null ? {} : { branchId: register.branchId, locationId: register.locationId };
}
