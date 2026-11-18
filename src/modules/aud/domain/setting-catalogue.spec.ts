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

describe('the offline till settings (OFFLINE_SYNC 5.2, B09b continued 2, A-277 (b))', () => {
  it('has each key with its documented default, and never a weaker bound than the owner set', () => {
    expect(SETTING_CATALOGUE['pos.offline.max_hours']).toMatchObject({ valueType: 'INTEGER', defaultValue: 8, min: 1, max: 8, branchScoped: true });
    expect(SETTING_CATALOGUE['pos.offline.max_queued_sales']).toMatchObject({ valueType: 'INTEGER', defaultValue: 500, min: 1, max: 500, branchScoped: true });
    expect(SETTING_CATALOGUE['pos.offline.allow_unverified_mobile_money']).toMatchObject({ valueType: 'BOOLEAN', defaultValue: false, branchScoped: true });
    expect(SETTING_CATALOGUE['sync.clock_tolerance_seconds']).toMatchObject({ valueType: 'INTEGER', defaultValue: 300, min: 30, max: 300, branchScoped: false });
    expect(SETTING_CATALOGUE['pay.unverified_window_days']).toMatchObject({ valueType: 'INTEGER', defaultValue: 3, min: 1, max: 3, branchScoped: false });
  });

  it('takes an integer within its range and refuses one beyond it', () => {
    expect(judgeSetting('pos.offline.max_hours', 4).ok).toBe(true);
    expect(judgeSetting('pos.offline.max_hours', 9)).toEqual({ ok: false, error: 'OUT_OF_RANGE' });
    expect(judgeSetting('pos.offline.max_queued_sales', 501)).toEqual({ ok: false, error: 'OUT_OF_RANGE' });
    expect(judgeSetting('sync.clock_tolerance_seconds', 301)).toEqual({ ok: false, error: 'OUT_OF_RANGE' });
    expect(judgeSetting('sync.clock_tolerance_seconds', 29)).toEqual({ ok: false, error: 'OUT_OF_RANGE' });
    expect(judgeSetting('pos.offline.max_hours', true)).toEqual({ ok: false, error: 'WRONG_TYPE' });
  });

  it('takes a boolean for a boolean setting and nothing else', () => {
    expect(judgeSetting('pos.offline.allow_unverified_mobile_money', true)).toEqual({ ok: true, value: { definition: SETTING_CATALOGUE['pos.offline.allow_unverified_mobile_money'], value: true } });
    expect(judgeSetting('pos.offline.allow_unverified_mobile_money', false).ok).toBe(true);
    expect(judgeSetting('pos.offline.allow_unverified_mobile_money', 1)).toEqual({ ok: false, error: 'WRONG_TYPE' });
  });
});
