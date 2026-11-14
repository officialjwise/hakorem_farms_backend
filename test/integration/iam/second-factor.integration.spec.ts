import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { Resvg } from '@resvg/resvg-js';
import jsQR from 'jsqr';
import { Controller, Module, Post, Inject } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, totpAt } from '../../../src/modules/iam/domain/totp';
import { Authoriser, IamModule } from '../../../src/modules/iam';
import type { Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { CurrentActor } from '../../../src/platform/http/actor-param';
import { Operation } from '../../../src/platform/http/operation';
import { CookieJar, createBranch, createUser, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestBranch } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** A route guarded by a permission that needs a fresh step-up, standing in for a distribution posting. */
@Controller('probe')
class StepUpProbeController {
  constructor(
    @Inject(UnitOfWork) private readonly uow: UnitOfWork,
    @Inject(Authoriser) private readonly authoriser: Authoriser,
  ) {}

  @Post('sensitive')
  @Operation({ operationId: 'probeSensitive', access: 'SESSION', realms: ['STAFF'], permission: 'cap.probe.post', idempotent: false, csrf: true, rateLimit: 'console' })
  async sensitive(@CurrentActor() actor: Actor | undefined): Promise<{ ok: true }> {
    await this.uow.run({ isolation: 'read committed' }, (tx) => this.authoriser.authorise(tx, actor, 'cap.probe.post'));
    return { ok: true };
  }
}

let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let dodowa: TestBranch;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  @Module({ imports: [IamModule], controllers: [StepUpProbeController] })
  class ProbeModule {}
  api = await startTestApp(database, { clock, imports: [ProbeModule] });
  dodowa = await createBranch(database);
  // A permission that requires step-up, held by the Owner role only for this test.
  const admin = database.pool('admin');
  await admin.query("INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES ('cap.probe.post', 'cap', 'Probe', true)");
  await admin.query("INSERT INTO iam.role_permission (role_id, permission_code, created_by) VALUES ('01900000-0000-7000-8000-000000000101', 'cap.probe.post', $1)", [
    SYSTEM_PRINCIPAL,
  ]);
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

const post = (path: string, body: object) => request(api.server).post(path).set('Origin', TEST_ORIGIN).send(body);
const unixNow = () => Math.floor(clock.now().getTime() / 1000);

/** Logs an Owner in through first-time enrolment, returning the cookies, the TOTP secret and the recovery codes. */
async function enrolOwner(name: string) {
  const owner = await createUser(database, { name, grants: [{ role: 'OWNER', branchId: dodowa.branchId }] });
  const first = await post('/v1/auth/staff/login', { identifier: owner.identifier, password: owner.password });
  expect(first.body).toEqual({ status: 'TOTP_ENROLMENT_REQUIRED', challengeToken: expect.stringMatching(/^hk1\.ch\./), session: null });
  const challengeToken = first.body.challengeToken as string;
  const started = await post('/v1/auth/totp/enrol', { challengeToken });
  expect(started.status).toBe(200);
  expect(started.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/HaKorem%20Farms:/);
  // CR-006: the QR code is the same URI, drawn; read back by an independent renderer and decoder.
  const svg = Buffer.from((started.body.qrCodeDataUri as string).replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString('utf8');
  const image = new Resvg(svg, { fitTo: { mode: 'width', value: 600 }, background: 'white' }).render();
  expect(jsQR(new Uint8ClampedArray(image.pixels), image.width, image.height)?.data).toBe(started.body.otpauthUri);
  const secret = base32Decode(started.body.secretBase32 as string);
  const confirmed = await post('/v1/auth/totp/confirm', { challengeToken, code: totpAt(secret, unixNow()) });
  expect(confirmed.status).toBe(200);
  expect(confirmed.body.recoveryCodes).toHaveLength(8);
  const jar = new CookieJar();
  jar.store(confirmed.headers['set-cookie']);
  return { owner, secret, recoveryCodes: confirmed.body.recoveryCodes as string[], jar };
}

describe('TOTP for privileged roles (ADR-0016, FR-IAM-003)', () => {
  it('makes an Owner enrol a second factor before any session exists, and completes the login at confirmation', async () => {
    const { jar } = await enrolOwner('Kwabena Owusu');
    const session = await request(api.server).get('/v1/auth/session').set('Cookie', jar.header());
    expect(session.status).toBe(200);
    expect(session.body.totpEnrolled).toBe(true);
    expect(session.body.steppedUpAt).not.toBeNull();
  });

  it('asks an enrolled Owner for a code at every login, and refuses the same code twice', async () => {
    const { owner, secret } = await enrolOwner('Akua Mensah');
    clock.advanceBy(30_000);
    const step = await post('/v1/auth/staff/login', { identifier: owner.identifier, password: owner.password });
    expect(step.body.status).toBe('TOTP_REQUIRED');
    const code = totpAt(secret, unixNow());
    const verified = await post('/v1/auth/totp/verify', { challengeToken: step.body.challengeToken, code });
    expect(verified.status).toBe(200);
    expect(verified.body.status).toBe('AUTHENTICATED');

    const again = await post('/v1/auth/staff/login', { identifier: owner.identifier, password: owner.password });
    const replay = await post('/v1/auth/totp/verify', { challengeToken: again.body.challengeToken, code });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('TOTP_INVALID');
  });

  it('spends a challenge after five wrong codes', async () => {
    const { owner } = await enrolOwner('Nana Yeboah');
    const step = await post('/v1/auth/staff/login', { identifier: owner.identifier, password: owner.password });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await post('/v1/auth/totp/verify', { challengeToken: step.body.challengeToken, code: '000000' })).body.error.code).toBe('TOTP_INVALID');
    }
    const spent = await post('/v1/auth/totp/verify', { challengeToken: step.body.challengeToken, code: '000000' });
    expect(spent.status).toBe(401);
    expect(spent.body.error.code).toBe('CHALLENGE_EXPIRED');
  });

  it('accepts a recovery code once, in place of a TOTP code', async () => {
    const { owner, recoveryCodes } = await enrolOwner('Kwesi Appiah');
    const first = await post('/v1/auth/staff/login', { identifier: owner.identifier, password: owner.password });
    expect((await post('/v1/auth/totp/verify', { challengeToken: first.body.challengeToken, code: recoveryCodes[0] })).status).toBe(200);
    const second = await post('/v1/auth/staff/login', { identifier: owner.identifier, password: owner.password });
    expect((await post('/v1/auth/totp/verify', { challengeToken: second.body.challengeToken, code: recoveryCodes[0] })).status).toBe(401);
  });

  it('stores the TOTP secret encrypted, never in clear', async () => {
    const { owner, secret } = await enrolOwner('Efua Asante');
    const { rows } = await database.pool('admin').query<{ secret_enc: Buffer }>('SELECT secret_enc FROM iam.totp_credential WHERE principal_id = $1', [owner.principalId]);
    const stored = rows[0]!.secret_enc;
    expect(stored.includes(secret)).toBe(false);
    expect(stored.toString('latin1')).not.toContain(Buffer.from(secret).toString('hex').toUpperCase().slice(0, 8));
  });
});

describe('step-up (ADR-0016, docs/API.md section 3.4)', () => {
  it('requires a TOTP code within the last five minutes for a step-up permission, and accepts one after POST /auth/step-up', async () => {
    const { jar, secret } = await enrolOwner('Abena Owusu');
    const csrf = (await request(api.server).get('/v1/auth/session').set('Cookie', jar.header())).body.csrfToken as string;
    const sensitive = () => request(api.server).post('/v1/probe/sensitive').set('Cookie', jar.header()).set('Origin', TEST_ORIGIN).set('X-CSRF-Token', csrf);

    expect((await sensitive()).status).toBe(201);
    clock.advanceBy(301_000);
    // The access token has 10 minutes; the step-up only 5.
    const stale = await sensitive();
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe('STEP_UP_REQUIRED');

    clock.advanceBy(30_000);
    const stepped = await request(api.server)
      .post('/v1/auth/step-up')
      .set('Cookie', jar.header())
      .set('Origin', TEST_ORIGIN)
      .set('X-CSRF-Token', csrf)
      .send({ code: totpAt(secret, unixNow()) });
    expect(stepped.status).toBe(200);
    expect(Date.parse(stepped.body.steppedUpAt)).toBe(clock.now().getTime());
    expect((await sensitive()).status).toBe(201);
  });
});

describe('temporary passwords (FR-IAM-002) and password rules (SA-20, FR-IAM-005)', () => {
  it('sends a new account with a temporary password to change it, through the challenge, before any session exists', async () => {
    const storekeeper = await createUser(database, { name: 'Yaa Asantewaa', mustChangePassword: true, grants: [{ role: 'STOREKEEPER', branchId: dodowa.branchId }] });
    const first = await post('/v1/auth/staff/login', { identifier: storekeeper.identifier, password: storekeeper.password });
    expect(first.body.status).toBe('PASSWORD_CHANGE_REQUIRED');
    const newPassword = `Cassava-Harvest-${randomUUID().slice(0, 8)}`;
    const changed = await post('/v1/auth/password/change', { challengeToken: first.body.challengeToken, currentPassword: storekeeper.password, newPassword });
    expect(changed.status).toBe(204);
    expect((await post('/v1/auth/staff/login', { identifier: storekeeper.identifier, password: storekeeper.password })).status).toBe(401);
    const second = await post('/v1/auth/staff/login', { identifier: storekeeper.identifier, password: newPassword });
    expect(second.body.status).toBe('AUTHENTICATED');
    expect(second.body.session.mustChangePassword).toBe(false);
  });

  it('refuses a password from the breached-password list, and one shorter than twelve characters, naming the field', async () => {
    const sales = await createUser(database, { name: 'Kojo Antwi', mustChangePassword: true, grants: [{ role: 'SALES', branchId: dodowa.branchId }] });
    const first = await post('/v1/auth/staff/login', { identifier: sales.identifier, password: sales.password });
    const breached = await post('/v1/auth/password/change', { challengeToken: first.body.challengeToken, currentPassword: sales.password, newPassword: 'password1234' });
    expect(breached.status).toBe(422);
    expect(breached.body.error.code).toBe('PASSWORD_BREACHED');
    const short = await post('/v1/auth/password/change', { challengeToken: first.body.challengeToken, currentPassword: sales.password, newPassword: 'Short-1' });
    expect(short.status).toBe(400);
    expect(short.body.error.details).toEqual([{ field: '/newPassword', code: 'TOO_SHORT', message: 'Use at least 12 characters.' }]);
  });
});
