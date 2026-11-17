import type { INestApplicationContext } from '@nestjs/common';
import type pg from 'pg';
import { BusinessProfiles, type BusinessProfileUpdate } from '../modules/aud';
import { PG_POOL } from '../platform/platform.module';
import { SeedStaff } from './seed-staff';
import type { ServiceSeedUnit } from './seed-unit';

/**
 * The farm's business profile (B09x continued, FR-AUD-008, CR-028), SEED and invented: no real business's name, tax
 * number or phone. The two numbers are from the seed's own `+2332000001..` block, the tax identification number is all
 * zeros but its last digit, the email is in `.invalid`, and every text says SEED. The shop shows the trading name, the
 * numbers, the address, the directions and the hours through `getShopProfile`. Set by the seeded Owner through AUD's
 * `BusinessProfiles`, with the seed's step-up waiver; a second run writes nothing.
 */
export const SEED_BUSINESS_PROFILE = {
  version: 0,
  legalName: 'HaKorem Farms Limited (SEED)',
  tradingName: 'HaKorem Farms (SEED)',
  tin: 'C0000000001',
  address: 'Off the Dodowa-Afienya road, Dodowa, GE-293-0471 (SEED)',
  phone: '+233200000120',
  whatsapp: '+233200000121',
  email: 'shop@seed.hakoremfarms.invalid',
  directions: 'From Dodowa lorry station, take the Afienya road for two kilometres; the farm gate is on the left after the Presby church (SEED).',
  openingHours: [
    ...(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] as const).map((day) => ({ day, opens: '07:00', closes: '18:00' })),
    { day: 'SATURDAY', opens: '07:00', closes: '14:00' },
  ],
} as const satisfies BusinessProfileUpdate;

export function farmSeedAud(): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'aud-business-profile',
    async run(app: INestApplicationContext) {
      const pool = app.get<pg.Pool>(PG_POOL);
      if ((await pool.query("SELECT 1 FROM platform.setting WHERE key = 'aud.business_profile' AND deleted_at IS NULL")).rows.length > 0) return { records: 0 };
      const staff = await SeedStaff.load(app);
      await staff.as('owner', (owner) => app.get(BusinessProfiles).update(owner, SEED_BUSINESS_PROFILE, 'seed:aud:business-profile'));
      return { records: 1 };
    },
  };
}
