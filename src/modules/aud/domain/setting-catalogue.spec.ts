import { describe, expect, it } from 'vitest';
import { judgeSetting, SETTING_CATALOGUE } from './setting-catalogue';

describe('the setting catalogue (FR-AUD-007)', () => {
  const limit = 'pur.purchase_order.approval_limit_pesewas';

  it('takes the purchase order approval limit as whole pesewas from 0 up', () => {
    expect(judgeSetting(limit, 100_000)).toEqual({ ok: true, value: { definition: SETTING_CATALOGUE[limit], value: 100_000 } });
    expect(judgeSetting(limit, 0).ok).toBe(true);
    expect(SETTING_CATALOGUE[limit]).toMatchObject({ valueType: 'PESEWAS', defaultValue: 200_000, branchScoped: true });
  });

  it('refuses a negative, fractional, too large or non-numeric limit, and an unknown key', () => {
    expect(judgeSetting(limit, -5)).toEqual({ ok: false, error: 'OUT_OF_RANGE' });
    expect(judgeSetting(limit, Number.MAX_SAFE_INTEGER + 1)).toEqual({ ok: false, error: 'OUT_OF_RANGE' });
    expect(judgeSetting(limit, 1.5)).toEqual({ ok: false, error: 'WRONG_TYPE' });
    expect(judgeSetting(limit, '200000')).toEqual({ ok: false, error: 'WRONG_TYPE' });
    expect(judgeSetting('pur.nothing_here', 1)).toEqual({ ok: false, error: 'UNKNOWN_SETTING' });
  });
});
