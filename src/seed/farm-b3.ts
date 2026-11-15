import { createHash } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { createUuidV7Generator, ManualClock, systemClock } from '@hakorem/kernel';
import type pg from 'pg';
import type { SqlSeedUnit } from './seed-unit';

/**
 * B3's slice of the seeded farm (hakorem-seed), now the IAM part only: a staff member in each seeded role at the
 * Dodowa branch. Everything is marked as seed: emails end in `.invalid`, phone numbers come from the seed block
 * +233 20 000 0xxx. The branches, locations and catalogue it once wrote are written through MDM's services by
 * farm-mdm.ts.
 *
 * It still writes SQL because IAM user and grant administration is B04e's (A-085). Ids are UUIDv7 from a fixed
 * clock and a fixed random source, so a second run finds every row and changes nothing.
 */
const SYSTEM = '01900000-0000-7000-8000-000000000001';
const SEED_INSTANT = new Date('2026-11-01T06:00:00Z');
const ROLE = {
  OWNER: '01900000-0000-7000-8000-000000000101',
  MANAGER: '01900000-0000-7000-8000-000000000102',
  ACCOUNTANT: '01900000-0000-7000-8000-000000000103',
  STOREKEEPER: '01900000-0000-7000-8000-000000000104',
  CASHIER: '01900000-0000-7000-8000-000000000105',
  SALES: '01900000-0000-7000-8000-000000000106',
  FARM_HAND: '01900000-0000-7000-8000-000000000107',
  DRIVER: '01900000-0000-7000-8000-000000000108',
} as const;

/** A deterministic random source: SHA-256 in counter mode over a fixed seed. */
function seededRandom(seed: string): (length: number) => Uint8Array {
  let counter = 0;
  return (length) => {
    const out = new Uint8Array(length);
    for (let filled = 0; filled < length; ) {
      const block = createHash('sha256').update(`${seed}:${counter++}`).digest();
      const take = Math.min(block.length, length - filled);
      out.set(block.subarray(0, take), filled);
      filled += take;
    }
    return out;
  };
}

/**
 * Ids B3 drew before its rows moved to farm-mdm.ts: two branches, fourteen locations in each (six physical, eight
 * virtual), and its catalogue rows (4 categories, 7 species, 6 products).
 */
const MOVED_IDS = 2 + 2 * 14 + 17;

interface StaffMember {
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly role: keyof typeof ROLE;
  readonly location?: 'SHOP' | 'PENS' | 'COLD';
}

const STAFF: readonly StaffMember[] = [
  { name: 'Kwabena Owusu', email: 'kwabena.owusu@seed.hakoremfarms.invalid', phone: '+233200000101', role: 'OWNER' },
  { name: 'Akosua Boateng', email: 'akosua.boateng@seed.hakoremfarms.invalid', phone: '+233200000102', role: 'MANAGER' },
  { name: 'Yaw Agyeman', email: 'yaw.agyeman@seed.hakoremfarms.invalid', phone: '+233200000103', role: 'ACCOUNTANT' },
  { name: 'Kofi Mensah', email: 'kofi.mensah@seed.hakoremfarms.invalid', phone: '+233200000104', role: 'STOREKEEPER', location: 'COLD' },
  { name: 'Adwoa Darko', email: 'adwoa.darko@seed.hakoremfarms.invalid', phone: '+233200000105', role: 'CASHIER', location: 'SHOP' },
  { name: 'Esi Appiah', email: 'esi.appiah@seed.hakoremfarms.invalid', phone: '+233200000106', role: 'SALES' },
  { name: 'Abdul-Rahman Iddrisu', email: 'abdul.iddrisu@seed.hakoremfarms.invalid', phone: '+233200000107', role: 'FARM_HAND', location: 'PENS' },
  { name: 'Selorm Agbeko', email: 'selorm.agbeko@seed.hakoremfarms.invalid', phone: '+233200000108', role: 'DRIVER' },
];

/** The seeded farm in B3. Requires SEED_STAFF_PASSWORD: staff passwords are generated per machine, never fixed. */
export function farmSeedB3(staffPassword: string | undefined): SqlSeedUnit {
  return {
    kind: 'SQL',
    name: 'b3-scope-staff-catalogue',
    async run(client: pg.PoolClient) {
      if (staffPassword === undefined || staffPassword.length < 12) {
        throw new Error('SEED_STAFF_PASSWORD must be set (pnpm run setup generates it into .env) and at least 12 characters');
      }
      const id = createUuidV7Generator(new ManualClock(SEED_INSTANT), seededRandom('hakorem-seed-b3'));
      let records = 0;
      const insert = async (text: string, values: unknown[]) => {
        records += (await client.query(text, values)).rowCount ?? 0;
      };

      // The branches and locations B3 wrote, and its catalogue rows, moved to MDM's services (farm-mdm.ts). Their ids
      // are still drawn, so the staff below keep the ids an earlier run gave them.
      for (let moved = 0; moved < MOVED_IDS; moved += 1) {
        id();
      }
      const { rows: branches } = await client.query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW' AND deleted_at IS NULL");
      const dodowa = branches[0]?.id;
      if (dodowa === undefined) {
        throw new Error('the staff need the Dodowa branch, which the mdm-bootstrap seed unit creates; run the seed units in order');
      }

      // Staff: one person per role at Dodowa, each with the seeded password. Owner, Manager and Accountant enrol TOTP
      // at their first login, as the console's first-run flow does.
      const passwordHash = await hash(staffPassword, { algorithm: 2, memoryCost: 65_536, timeCost: 3, parallelism: 1 });
      for (const member of STAFF) {
        const principal = id();
        const created = await client.query(
          `INSERT INTO iam.principal (id, kind, display_name, status, created_by, updated_by) VALUES ($1, 'USER', $2, 'ACTIVE', $3, $3) ON CONFLICT (id) DO NOTHING`,
          [principal, member.name, SYSTEM],
        );
        records += created.rowCount ?? 0;
        if (created.rowCount === 0) {
          id(); // keep the id sequence identical on a re-run
          continue;
        }
        await insert(
          `INSERT INTO iam.user_account (principal_id, realm, email, phone_e164, password_hash, password_changed_at, created_by, updated_by)
           VALUES ($1, 'STAFF', $2, $3, $4, $5, $6, $6)`,
          [principal, member.email, member.phone, passwordHash, SEED_INSTANT, SYSTEM],
        );
        // A grant scoped to a location waits for the location: seedLocationGrants writes it after MDM's services
        // have created the locations. Its id is drawn here all the same.
        const grantId = id();
        if (member.location === undefined) {
          await insert(
            `INSERT INTO iam.role_grant (id, principal_id, role_id, branch_id, location_id, created_by, updated_by) VALUES ($1, $2, $3, $4, NULL, $5, $5)`,
            [grantId, principal, ROLE[member.role], dodowa, SYSTEM],
          );
        }
      }

      await insert(
        `INSERT INTO platform.setting (id, key, value, value_type, description, created_by, updated_by)
         VALUES ($1, 'seed.loaded', $2, 'JSON', 'The seeded farm: version and date. SEED', $3, $3) ON CONFLICT DO NOTHING`,
        [id(), JSON.stringify({ slice: 'b3', loadedFor: SEED_INSTANT.toISOString() }), SYSTEM],
      );
      return { records };
    },
  };
}

/**
 * The staff grants scoped to a location (the Storekeeper at the cold room, the Cashier at the shop floor, the Farm
 * Hand at the pens), written once MDM's services have created those locations. IAM SQL until B04e, like the rest
 * of the staff; a grant already there is left alone.
 */
export function seedLocationGrants(): SqlSeedUnit {
  return {
    kind: 'SQL',
    name: 'iam-location-grants',
    async run(client: pg.PoolClient) {
      const nextId = createUuidV7Generator(systemClock);
      let records = 0;
      for (const member of STAFF) {
        if (member.location === undefined) continue;
        const { rows } = await client.query<{ principal_id: string; branch_id: string; location_id: string }>(
          `SELECT u.principal_id, l.branch_id, l.id AS location_id
             FROM iam.user_account u, mdm.location l JOIN mdm.branch b ON b.id = l.branch_id
            WHERE u.email = $1 AND b.code = 'DDW' AND l.code = $2 AND l.deleted_at IS NULL`,
          [member.email, member.location],
        );
        const found = rows[0];
        if (found === undefined) {
          throw new Error(`the grant of ${member.email} needs location DDW:${member.location}, which the mdm-services seed unit creates`);
        }
        const created = await client.query(
          `INSERT INTO iam.role_grant (id, principal_id, role_id, branch_id, location_id, created_by, updated_by)
           SELECT $1, $2, $3, $4, $5, $6, $6
            WHERE NOT EXISTS (SELECT 1 FROM iam.role_grant WHERE principal_id = $2 AND role_id = $3 AND branch_id = $4 AND location_id = $5)`,
          [nextId(), found.principal_id, ROLE[member.role], found.branch_id, found.location_id, SYSTEM],
        );
        records += created.rowCount ?? 0;
      }
      return { records };
    },
  };
}
