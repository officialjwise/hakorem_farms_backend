import { createHash } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import type pg from 'pg';
import type { SqlSeedUnit } from './seed-unit';

/**
 * B3's slice of the seeded farm (hakorem-seed): the Dodowa farm and shop and the smoke-suite test branch with
 * their locations, and a staff member in each seeded role. Everything is marked as seed: emails end in `.invalid`,
 * phone numbers come from the seed block +233 20 000 0xxx. The catalogue it once wrote is now written through MDM's
 * services by farm-mdm.ts.
 *
 * This slice still writes SQL because the services it would call are not built yet: branches and locations
 * (B04d continued 2) and IAM user creation (B04e) (A-085). Ids are UUIDv7 from a fixed clock and
 * a fixed random source, so a second run finds every row and changes nothing.
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

/** Ids B3 drew for its catalogue rows (4 categories, 7 species, 6 products) before they moved to farm-mdm.ts. */
const MOVED_CATALOGUE_IDS = 17;

const VIRTUAL_KINDS = ['SUPPLIER', 'CUSTOMER', 'PRODUCTION', 'PROCESSING', 'CONSUMPTION', 'LOSS', 'ADJUSTMENT', 'OPENING'] as const;

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

      // Branches: the farm and shop at Dodowa, and the smoke-suite branch (ADR-0007).
      const dodowa = id();
      const test = id();
      for (const [branchId, code, name, isTest] of [
        [dodowa, 'DDW', 'Dodowa farm and shop (SEED)', false],
        [test, 'TST', 'Smoke test branch (SEED)', true],
      ] as const) {
        await insert(
          `INSERT INTO mdm.branch (id, code, name, address, phone_e164, is_test, status, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $7) ON CONFLICT (id) DO NOTHING`,
          [branchId, code, name, 'Off the Dodowa-Afienya road, Dodowa, GE-293-0471 (SEED)', '+233200000001', isTest, SYSTEM],
        );
      }
      const locations: Record<string, string> = {};
      for (const [branchId, prefix] of [
        [dodowa, 'DDW'],
        [test, 'TST'],
      ] as const) {
        const site = id();
        locations[`${prefix}:SITE`] = site;
        const physical = [
          ['SITE', 'Farm site', 'SITE', null, false],
          ['PENS', 'Goat and sheep pens', 'PEN', site, false],
          ['COLD', 'Cold room', 'COLD_ROOM', site, false],
          ['SHOP', 'Shop floor', 'SHOP_FLOOR', site, true],
          ['VAN1', 'Delivery van GT 4471-26 (SEED)', 'VEHICLE', site, false],
          ['RETURNS', 'Customer returns holding area', 'RETURNS_HOLD', site, false],
        ] as const;
        for (const [code, name, kind, parent, sellable] of physical) {
          const locationId = code === 'SITE' ? site : id();
          locations[`${prefix}:${code}`] = locationId;
          await insert(
            `INSERT INTO mdm.location (id, branch_id, parent_id, code, name, kind, is_virtual, is_sellable, temp_class, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, $9, $9) ON CONFLICT (id) DO NOTHING`,
            [locationId, branchId, parent, code, name, kind, sellable, kind === 'COLD_ROOM' ? 'FROZEN' : null, SYSTEM],
          );
        }
        for (const kind of VIRTUAL_KINDS) {
          await insert(
            `INSERT INTO mdm.location (id, branch_id, code, name, kind, is_virtual, allows_negative, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, true, $6, $7, $7) ON CONFLICT (id) DO NOTHING`,
            [id(), branchId, `V-${kind.replace('_', '-')}`, `Virtual: ${kind.toLowerCase()}`, kind, kind !== 'CUSTOMER', SYSTEM],
          );
        }
      }

      // The catalogue's categories, species and six products moved to farm-mdm.ts, which writes them through MDM's
      // services. Their 17 ids are still drawn, so the staff below keep the ids an earlier run gave them.
      for (let moved = 0; moved < MOVED_CATALOGUE_IDS; moved += 1) {
        id();
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
        await insert(
          `INSERT INTO iam.role_grant (id, principal_id, role_id, branch_id, location_id, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [id(), principal, ROLE[member.role], dodowa, member.location === undefined ? null : locations[`DDW:${member.location}`], SYSTEM],
        );
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
