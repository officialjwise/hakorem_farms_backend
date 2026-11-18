import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type pg from 'pg';
import { AccessAdmin, AuthenticationService } from '../modules/iam';
import { runWithRequestContext, type Actor } from '../platform/context/request-context';
import { PG_POOL } from '../platform/platform.module';
import { SEED_STAFF, SEED_USER_AGENT, SeedStaff } from './seed-staff';
import type { ServiceSeedUnit } from './seed-unit';

/**
 * The IAM slice of the seeded farm, written through IAM's services (A-085, ADR-0041, ADR-0043): one staff member per
 * seeded role at the Dodowa branch. The System bootstraps the seeded Owner, who then creates every other account
 * and grant through `createUser` and `createGrant`; each person then signs in once with their temporary password
 * and sets the seeded password through the real first-login flow (`loginStaff`, then `changePassword` on the
 * challenge). Everything is marked as seed: emails end in `.invalid`, phone numbers come from the seed block
 * +233 20 000 0xxx. A person already there (found by email) is left alone, so a second run writes nothing.
 */
const SYSTEM_PRINCIPAL = '01900000-0000-7000-8000-000000000001';
const ROLE = {
  MANAGER: '01900000-0000-7000-8000-000000000102',
  ACCOUNTANT: '01900000-0000-7000-8000-000000000103',
  STOREKEEPER: '01900000-0000-7000-8000-000000000104',
  CASHIER: '01900000-0000-7000-8000-000000000105',
  SALES: '01900000-0000-7000-8000-000000000106',
  FARM_HAND: '01900000-0000-7000-8000-000000000107',
  DRIVER: '01900000-0000-7000-8000-000000000108',
} as const;

interface StaffMember {
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly role: keyof typeof ROLE;
  readonly location?: 'SHOP' | 'PENS' | 'COLD';
}

const OWNER = { name: 'Kwabena Owusu', email: SEED_STAFF.owner, phone: '+233200000101' } as const;

export const SEED_STAFF_MEMBERS: readonly StaffMember[] = [
  { name: 'Akosua Boateng', email: SEED_STAFF.manager, phone: '+233200000102', role: 'MANAGER' },
  { name: 'Yaw Agyeman', email: SEED_STAFF.accountant, phone: '+233200000103', role: 'ACCOUNTANT' },
  { name: 'Kofi Mensah', email: 'kofi.mensah@seed.hakoremfarms.invalid', phone: '+233200000104', role: 'STOREKEEPER', location: 'COLD' },
  { name: 'Adwoa Darko', email: 'adwoa.darko@seed.hakoremfarms.invalid', phone: '+233200000105', role: 'CASHIER', location: 'SHOP' },
  { name: 'Esi Appiah', email: 'esi.appiah@seed.hakoremfarms.invalid', phone: '+233200000106', role: 'SALES' },
  { name: 'Abdul-Rahman Iddrisu', email: 'abdul.iddrisu@seed.hakoremfarms.invalid', phone: '+233200000107', role: 'FARM_HAND', location: 'PENS' },
  { name: 'Selorm Agbeko', email: 'selorm.agbeko@seed.hakoremfarms.invalid', phone: '+233200000108', role: 'DRIVER' },
  // B10 continued (CR-048): a second Manager at Dodowa, so a release from hold or a credit limit change asked by one
  // Owner or Manager always has another to approve it.
  { name: 'Efua Boakye', email: SEED_STAFF.manager2, phone: '+233200000109', role: 'MANAGER' },
];

const key = (...parts: string[]): string => `seed:iam:${parts.join(':')}`;

function seedContext<T>(actor: Actor | undefined, work: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: SEED_USER_AGENT, ...(actor === undefined ? {} : { actor }) }, work);
}

async function principalOf(pool: pg.Pool, email: string): Promise<string | null> {
  const { rows } = await pool.query<{ principal_id: string }>("SELECT principal_id FROM iam.user_account WHERE realm = 'STAFF' AND email = $1 AND deleted_at IS NULL", [email]);
  return rows[0]?.principal_id ?? null;
}

async function dodowaId(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW' AND deleted_at IS NULL");
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('the staff need the Dodowa branch, which the mdm-bootstrap seed unit creates; run the seed units in order');
  return id;
}

/** The first sign-in, as a person makes it: the temporary password, then the seeded password on the challenge. */
async function firstSignIn(app: INestApplicationContext, email: string, temporaryPassword: string, staffPassword: string): Promise<void> {
  const authentication = app.get(AuthenticationService);
  await seedContext(undefined, async () => {
    const outcome = await authentication.login('STAFF', { identifier: email, password: temporaryPassword, deviceLabel: 'Seed first sign-in' });
    if (outcome.kind !== 'CHALLENGE' || outcome.status !== 'PASSWORD_CHANGE_REQUIRED') {
      throw new Error(`the seeded account ${email} should have been asked to change its temporary password`);
    }
    await authentication.changePassword({ kind: 'CHALLENGE', token: outcome.challengeToken }, temporaryPassword, staffPassword);
  });
}

/** The IAM seed unit. Requires SEED_STAFF_PASSWORD: staff passwords are generated per machine, never fixed. */
export function farmSeedIam(staffPassword: string | undefined): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'iam-services',
    async run(app: INestApplicationContext) {
      if (staffPassword === undefined || staffPassword.length < 12) {
        throw new Error('SEED_STAFF_PASSWORD must be set (pnpm run setup generates it into .env) and at least 12 characters');
      }
      const pool = app.get<pg.Pool>(PG_POOL);
      const admin = app.get(AccessAdmin);
      const dodowa = await dodowaId(pool);
      let records = 0;

      if ((await principalOf(pool, OWNER.email)) === null) {
        const system: Actor = { principalId: SYSTEM_PRINCIPAL, kind: 'SYSTEM', displayName: 'System', realm: null, sessionId: null, steppedUpAt: null };
        const created = await seedContext(system, () => admin.bootstrapFirstOwner(system, { displayName: OWNER.name, email: OWNER.email, phone: OWNER.phone, branchId: dodowa }));
        await firstSignIn(app, OWNER.email, created.temporaryPassword, staffPassword);
        records += 2;
      }

      const staff = await SeedStaff.load(app);
      for (const member of SEED_STAFF_MEMBERS) {
        if ((await principalOf(pool, member.email)) !== null) continue;
        // A grant scoped to a location waits for the location: seedLocationGrantsIam adds it once MDM has created it.
        const grants = member.location === undefined ? [{ roleId: ROLE[member.role], branchId: dodowa }] : [];
        const created = await staff.as('owner', (owner) =>
          admin.createUser(owner, { displayName: member.name, email: member.email, phone: member.phone, realm: 'STAFF', grants }, key('user', member.email)),
        );
        await firstSignIn(app, member.email, created.body.temporaryPassword, staffPassword);
        records += 1 + grants.length;
      }
      return { records };
    },
  };
}

/**
 * The staff grants scoped to a location (the Storekeeper at the cold room, the Cashier at the shop floor, the Farm
 * Hand at the pens), granted by the seeded Owner through `createGrant` once MDM's services have created those
 * locations. A grant already there is left alone.
 */
export function seedLocationGrantsIam(): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'iam-location-grants',
    async run(app: INestApplicationContext) {
      const pool = app.get<pg.Pool>(PG_POOL);
      const admin = app.get(AccessAdmin);
      const staff = await SeedStaff.load(app);
      let records = 0;
      for (const member of SEED_STAFF_MEMBERS) {
        if (member.location === undefined) continue;
        const principalId = await principalOf(pool, member.email);
        const { rows } = await pool.query<{ branch_id: string; location_id: string }>(
          "SELECT l.branch_id, l.id AS location_id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = $1 AND l.deleted_at IS NULL",
          [member.location],
        );
        const found = rows[0];
        if (principalId === null || found === undefined) {
          throw new Error(`the grant of ${member.email} needs the account and location DDW:${member.location}, which earlier seed units create`);
        }
        const existing = await staff.as('owner', (owner) => admin.listGrants(owner, { principalId, roleId: ROLE[member.role], branchId: found.branch_id }, undefined, 100));
        if (existing.data.some((grant) => grant.location?.id === found.location_id)) continue;
        await staff.as('owner', (owner) =>
          admin.createGrant(owner, { principalId, roleId: ROLE[member.role], branchId: found.branch_id, locationId: found.location_id }, key('grant', member.email, member.location!)),
        );
        records += 1;
      }
      return { records };
    },
  };
}
