import { describe, expect, it } from 'vitest';
import { BUSINESS_PROFILE_KEY, judgeOpeningHours, SHOP_PROFILE_KEYS, shopProfileOf, type BusinessProfileValue } from './business-profile';

const profile: BusinessProfileValue = {
  legalName: 'HaKorem Farms Limited (SEED)',
  tradingName: 'HaKorem Farms (SEED)',
  tin: 'C0000000001',
  vatNumber: 'V0000000001',
  address: 'Off the Dodowa-Afienya road, Dodowa, GE-293-0471 (SEED)',
  phone: '+233200000120',
  whatsapp: '+233200000121',
  email: 'shop@seed.hakoremfarms.invalid',
  logoFileId: null,
  directions: 'Past the Presby church, second turning on the left (SEED)',
  openingHours: [{ day: 'MONDAY', opens: '07:00', closes: '18:00' }],
};

describe('the business profile (FR-AUD-008)', () => {
  it('is one setting, under its own key', () => {
    expect(BUSINESS_PROFILE_KEY).toBe('aud.business_profile');
  });

  it('puts opening hours in week order, each day by the time it opens', () => {
    const judged = judgeOpeningHours([
      { day: 'SATURDAY', opens: '08:00', closes: '14:00' },
      { day: 'MONDAY', opens: '14:00', closes: '18:00' },
      { day: 'MONDAY', opens: '07:00', closes: '12:00' },
      { day: 'SUNDAY', opens: '13:00', closes: '16:00' },
    ]);
    expect(judged).toEqual({
      ok: true,
      value: [
        { day: 'MONDAY', opens: '07:00', closes: '12:00' },
        { day: 'MONDAY', opens: '14:00', closes: '18:00' },
        { day: 'SATURDAY', opens: '08:00', closes: '14:00' },
        { day: 'SUNDAY', opens: '13:00', closes: '16:00' },
      ],
    });
  });

  it('takes no hours at all (closed every day), and two intervals that only meet', () => {
    expect(judgeOpeningHours([])).toEqual({ ok: true, value: [] });
    expect(judgeOpeningHours([{ day: 'FRIDAY', opens: '07:00', closes: '12:00' }, { day: 'FRIDAY', opens: '12:00', closes: '18:00' }]).ok).toBe(true);
  });

  it('refuses an interval that closes when or before it opens, naming that interval', () => {
    expect(judgeOpeningHours([{ day: 'MONDAY', opens: '07:00', closes: '18:00' }, { day: 'TUESDAY', opens: '18:00', closes: '18:00' }])).toEqual({
      ok: false,
      error: { field: '/openingHours/1/closes', code: 'CLOSES_BEFORE_OPENS' },
    });
    expect(judgeOpeningHours([{ day: 'TUESDAY', opens: '18:00', closes: '07:59' }])).toEqual({ ok: false, error: { field: '/openingHours/0/closes', code: 'CLOSES_BEFORE_OPENS' } });
  });

  it('refuses two intervals of one day that overlap by a minute, naming the one sent second', () => {
    expect(judgeOpeningHours([{ day: 'MONDAY', opens: '11:59', closes: '18:00' }, { day: 'MONDAY', opens: '07:00', closes: '12:00' }])).toEqual({
      ok: false,
      error: { field: '/openingHours/1', code: 'HOURS_OVERLAP' },
    });
    expect(judgeOpeningHours([{ day: 'MONDAY', opens: '07:00', closes: '12:00' }, { day: 'MONDAY', opens: '07:00', closes: '12:00' }]).ok).toBe(false);
  });

  it('shows the shop exactly the trading name, the two numbers, the address, the directions and the hours', () => {
    const shop = shopProfileOf(profile);
    expect(Object.keys(shop).sort()).toEqual([...SHOP_PROFILE_KEYS].sort());
    expect(SHOP_PROFILE_KEYS).toEqual(['tradingName', 'phone', 'whatsapp', 'address', 'directions', 'openingHours']);
    expect(shop).toEqual({
      tradingName: 'HaKorem Farms (SEED)',
      phone: '+233200000120',
      whatsapp: '+233200000121',
      address: 'Off the Dodowa-Afienya road, Dodowa, GE-293-0471 (SEED)',
      directions: 'Past the Presby church, second turning on the left (SEED)',
      openingHours: [{ day: 'MONDAY', opens: '07:00', closes: '18:00' }],
    });
    expect(JSON.stringify(shop)).not.toMatch(/C0000000001|V0000000001|Limited|shop@seed/);
  });

  it('copies the hours, so the shop shape shares nothing with the profile it came from', () => {
    const shop = shopProfileOf(profile);
    expect(shop.openingHours).not.toBe(profile.openingHours);
    expect(shop.openingHours[0]).not.toBe(profile.openingHours[0]);
  });
});
