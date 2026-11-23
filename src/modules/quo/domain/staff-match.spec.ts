import { describe, expect, it } from 'vitest';
import { matchStaff, STAFF_MATCH_WINDOW_HOURS, staffWindowStart } from './staff-match';

const at = new Date('2026-11-23T12:00:00.000Z');
const UA = 'Mozilla/5.0 (Linux; Android 13) Chrome/131.0 Mobile (TEST)';
const hours = (h: number) => new Date(at.getTime() - h * 3_600_000);
const session = (id: string, principalId: string, lastSeenAt: Date, userAgent: string | null = UA, createdAt: Date = lastSeenAt) => ({ sessionId: id, principalId, lastSeenAt, createdAt, userAgent });

describe('a possible staff acceptance: a staff session active from the decision\'s address in the last 24 hours (the owner, 2026-11-23, A-343)', () => {
  it('opens its window exactly 24 hours before the decision, by the application clock', () => {
    expect([STAFF_MATCH_WINDOW_HOURS, staffWindowStart(at).toISOString()]).toEqual([24, '2026-11-22T12:00:00.000Z']);
  });

  it('flags a session seen an hour before from the same browser, naming the staff member', () => {
    expect(matchStaff({ ip: '198.51.100.23', userAgent: UA, at }, [session('s1', 'p-sales', hours(1))])).toEqual([{ principalId: 'p-sales', sessionId: 's1', sameBrowser: true, lastSeenAt: hours(1) }]);
  });

  it('flags a session seen exactly 24 hours before, and not one seen a millisecond earlier', () => {
    const edge = session('s1', 'p-sales', hours(24));
    const before = session('s2', 'p-sales', new Date(hours(24).getTime() - 1));
    expect(matchStaff({ ip: '198.51.100.23', userAgent: UA, at }, [edge, before]).map((m) => m.sessionId)).toEqual(['s1']);
  });

  it('flags the same address from another browser too, marked not the same browser (A-343 (c))', () => {
    expect(matchStaff({ ip: '198.51.100.23', userAgent: UA, at }, [session('s1', 'p-manager', hours(2), 'Mozilla/5.0 (Windows NT 10.0) Firefox/133.0 (TEST)')])).toEqual([
      { principalId: 'p-manager', sessionId: 's1', sameBrowser: false, lastSeenAt: hours(2) },
    ]);
  });

  it('never calls two unknown browsers the same browser', () => {
    expect(matchStaff({ ip: '198.51.100.23', userAgent: null, at }, [session('s1', 'p-sales', hours(1), null)]).map((m) => m.sameBrowser)).toEqual([false]);
    expect(matchStaff({ ip: '198.51.100.23', userAgent: UA, at }, [session('s1', 'p-sales', hours(1), null)]).map((m) => m.sameBrowser)).toEqual([false]);
  });

  it('compares the browser on the first 500 characters, as the decision keeps it', () => {
    const long = `${UA} ${'x'.repeat(600)}`;
    expect(matchStaff({ ip: '198.51.100.23', userAgent: long.slice(0, 500), at }, [session('s1', 'p-sales', hours(1), long)]).map((m) => m.sameBrowser)).toEqual([true]);
  });

  it('flags nothing with no address, and ignores a session created after the decision', () => {
    expect(matchStaff({ ip: null, userAgent: UA, at }, [session('s1', 'p-sales', hours(1))])).toEqual([]);
    expect(matchStaff({ ip: '198.51.100.23', userAgent: UA, at }, [session('s1', 'p-sales', new Date(at.getTime() + 1), UA, new Date(at.getTime() + 1))])).toEqual([]);
  });

  it('lists every matching session once, by staff member then session', () => {
    const seen = [session('s3', 'p-sales', hours(3)), session('s1', 'p-manager', hours(1)), session('s2', 'p-sales', hours(2)), session('s2', 'p-sales', hours(2))];
    expect(matchStaff({ ip: '198.51.100.23', userAgent: UA, at }, seen).map((m) => [m.principalId, m.sessionId])).toEqual([
      ['p-manager', 's1'],
      ['p-sales', 's2'],
      ['p-sales', 's3'],
    ]);
  });
});
