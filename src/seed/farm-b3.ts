import { createHash } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import type pg from 'pg';
import type { SeedUnit } from './seed-unit';

/**
 * B3's slice of the seeded farm (hakorem-seed): the Dodowa farm and shop and the smoke-suite test branch with
 * their locations, the catalogue's categories and species, a staff member in each seeded role, and six products
 * from the reference catalogue. Everything is marked as seed: emails end in `.invalid`, phone numbers come from the
 * seed block +233 20 000 0xxx, descriptions carry SEED.
 *
 * This slice writes SQL because the services it would call arrive in B4 (MDM branches, locations and categories;
 * IAM user creation). B4 regenerates it through the public interfaces (A-085). Ids are UUIDv7 from a fixed clock and
 * a fixed random source, so a second run finds every row and changes nothing.
 */
const SYSTEM = '01900000-0000-7000-8000-000000000001';
const SEED_INSTANT = new Date('2026-11-01T06:00:00Z');
const TAX = { LIVE_ANIMALS: '01900000-0000-7000-8000-000000000201', RAW_PRODUCE: '01900000-0000-7000-8000-000000000202', EGGS: '01900000-0000-7000-8000-000000000203', PROCESSED_MEAT: '01900000-0000-7000-8000-000000000204' };
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
export function farmSeedB3(staffPassword: string | undefined): SeedUnit {
  return {
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

      // Categories and species of the reference catalogue.
      const category: Record<string, string> = {};
      for (const [code, name, line, gl, tax, order] of [
        ['LIVE', 'Live animals', 'LIVE', 'LIVE_ANIMALS', TAX.LIVE_ANIMALS, 1],
        ['MEAT', 'Meat', 'MEAT', 'MEAT', TAX.PROCESSED_MEAT, 2],
        ['EGGS', 'Eggs', 'PRODUCE', 'PRODUCE_EGGS', TAX.EGGS, 3],
        ['PRODUCE', 'Fresh produce', 'PRODUCE', 'PRODUCE_EGGS', TAX.RAW_PRODUCE, 4],
      ] as const) {
        category[code] = id();
        await insert(
          `INSERT INTO mdm.category (id, code, name, product_line, gl_group, tax_category_id, sort_order, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) ON CONFLICT (id) DO NOTHING`,
          [category[code], code, name, line, gl, tax, order, SYSTEM],
        );
      }
      const species: Record<string, string> = {};
      for (const [code, name, tracking] of [
        ['GOAT', 'Goat', 'SERIAL'],
        ['SHEEP', 'Sheep', 'SERIAL'],
        ['PIG', 'Pig', 'SERIAL'],
        ['BROILER', 'Broiler chicken', 'LOT'],
        ['LOCAL_CHICKEN', 'Local chicken', 'LOT'],
        ['DUCK', 'Duck', 'LOT'],
        ['RABBIT', 'Rabbit', 'SERIAL'],
      ] as const) {
        species[code] = id();
        await insert(
          `INSERT INTO mdm.species (id, code, name, tracking_default, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (id) DO NOTHING`,
          [species[code], code, name, tracking, SYSTEM],
        );
      }

      // Products from the reference catalogue (shared brief). Prices are price list data and arrive in B4.
      for (const p of [
        { sku: 'LIV-GOAT', name: 'Goat', cat: 'LIVE', policy: 'SERIALISED', tracking: 'SERIAL', sp: 'GOAT', base: 'HEAD', sale: 'HEAD', mode: 'REQUEST_TO_BUY', gl: 'LIVE_ANIMALS', tax: TAX.LIVE_ANIMALS, pack: null, life: null, temp: null },
        { sku: 'LIV-SHEEP', name: 'Sheep', cat: 'LIVE', policy: 'SERIALISED', tracking: 'SERIAL', sp: 'SHEEP', base: 'HEAD', sale: 'HEAD', mode: 'REQUEST_TO_BUY', gl: 'LIVE_ANIMALS', tax: TAX.LIVE_ANIMALS, pack: null, life: null, temp: null },
        { sku: 'MEAT-GOAT-15KG', name: 'Goat meat, 15 kg pack', cat: 'MEAT', policy: 'CATCH_WEIGHT', tracking: 'LOT', sp: null, base: 'KG', sale: 'PACK', mode: 'LISTED', gl: 'MEAT', tax: TAX.PROCESSED_MEAT, pack: '15.000', life: 90, temp: 'FROZEN' },
        { sku: 'MEAT-CHICKEN-WINGS-15KG', name: 'Chicken wings, 15 kg pack', cat: 'MEAT', policy: 'CATCH_WEIGHT', tracking: 'LOT', sp: null, base: 'KG', sale: 'PACK', mode: 'LISTED', gl: 'MEAT', tax: TAX.PROCESSED_MEAT, pack: '15.000', life: 90, temp: 'FROZEN' },
        { sku: 'EGG-CRATE-BIG', name: 'Eggs, big, crate of 30', cat: 'EGGS', policy: 'COUNTABLE', tracking: 'LOT', sp: null, base: 'CRATE', sale: 'CRATE', mode: 'LISTED', gl: 'PRODUCE_EGGS', tax: TAX.EGGS, pack: null, life: 21, temp: 'AMBIENT' },
        { sku: 'PRD-YAM-TUBER', name: 'Yam, per tuber', cat: 'PRODUCE', policy: 'COUNTABLE', tracking: 'NONE', sp: null, base: 'TUBER', sale: 'TUBER', mode: 'LISTED', gl: 'PRODUCE_EGGS', tax: TAX.RAW_PRODUCE, pack: null, life: null, temp: null },
      ]) {
        await insert(
          `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, species_id, base_uom, sale_uom, nominal_pack_kg, tax_category_id,
                                    gl_group, shelf_life_days, storage_temp_class, description, online_mode, status, created_by, updated_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'ACTIVE', $17, $17, $18, $18) ON CONFLICT (id) DO NOTHING`,
          [id(), p.sku, p.name, category[p.cat], p.policy, p.tracking, p.sp === null ? null : species[p.sp], p.base, p.sale, p.pack, p.tax, p.gl, p.life, p.temp, `SEED. ${p.name} from the reference catalogue.`, p.mode, SYSTEM, SEED_INSTANT],
        );
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
