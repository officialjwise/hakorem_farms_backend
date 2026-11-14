import { createHash } from 'node:crypto';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { RangeQueryBreachedPasswords } from './breached-passwords';

const silent = pino({ level: 'silent' });
const settings = { enabled: true, baseUrl: 'https://range.example.test/range', timeoutMs: 1_000 };

function rangeAnswer(password: string, count: number): { prefix: string; body: string } {
  const digest = createHash('sha1').update(password).digest('hex').toUpperCase();
  return { prefix: digest.slice(0, 5), body: `0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n${digest.slice(5)}:${count}\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0` };
}

function fetchReturning(status: number, body: string, seen: string[] = []): typeof fetch {
  return (async (url: string | URL) => {
    seen.push(String(url));
    return new Response(body, { status });
  }) as typeof fetch;
}

describe('the breached-password check (FR-IAM-005, ADR-0016)', () => {
  it('sends only the first five characters of the SHA-1, and finds a breached password in the answer', async () => {
    const { prefix, body } = rangeAnswer('Kumasi-Market-2019', 37);
    const seen: string[] = [];
    const check = new RangeQueryBreachedPasswords(settings, silent, fetchReturning(200, body, seen));
    expect(await check.isBreached('Kumasi-Market-2019')).toBe(true);
    expect(seen).toEqual([`https://range.example.test/range/${prefix}`]);
  });

  it('passes a password the answer does not list, or lists with a padding count of zero', async () => {
    const listed = rangeAnswer('Cassava-Leaves-Stew', 0);
    expect(await new RangeQueryBreachedPasswords(settings, silent, fetchReturning(200, listed.body)).isBreached('Cassava-Leaves-Stew')).toBe(false);
    const other = rangeAnswer('Something-Else-Entirely', 5);
    expect(await new RangeQueryBreachedPasswords(settings, silent, fetchReturning(200, other.body)).isBreached('Plantain-Chips-Daily')).toBe(false);
  });

  it('falls back to the bundled list when the service fails, and uses it even when the service is switched off', async () => {
    const failing = new RangeQueryBreachedPasswords(settings, silent, fetchReturning(503, ''));
    expect(await failing.isBreached('Plantain-Chips-Daily')).toBe(false);
    expect(await failing.isBreached('Password1234')).toBe(true);
    const off = new RangeQueryBreachedPasswords({ ...settings, enabled: false }, silent, () => Promise.reject(new Error('must not be called')));
    expect(await off.isBreached('blackstars123')).toBe(true);
    expect(await off.isBreached('Plantain-Chips-Daily')).toBe(false);
  });
});
