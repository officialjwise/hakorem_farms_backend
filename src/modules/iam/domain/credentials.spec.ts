import { describe, expect, it } from 'vitest';
import { checkPasswordShape, normaliseIdentifier, refreshExpiry, type RealmLifetimes } from './credentials';

const staff: RealmLifetimes = { idleSeconds: 43_200, absoluteSeconds: 604_800 };

describe('password shape (SA-20, FR-IAM-005)', () => {
  it('accepts a twelve-character passphrase', () => {
    expect(checkPasswordShape('Mango-Season', 'adwoa.darko@hakoremfarms.com')).toBeNull();
  });

  it('refuses fewer than twelve characters, more than 128, and the login identifier itself', () => {
    expect(checkPasswordShape('Short-pass1', 'x@hakoremfarms.com')).toBe('TOO_SHORT');
    expect(checkPasswordShape('a'.repeat(129), 'x@hakoremfarms.com')).toBe('TOO_LONG');
    expect(checkPasswordShape('Adwoa.Darko@HaKoremFarms.com', 'adwoa.darko@hakoremfarms.com')).toBe('SAME_AS_IDENTIFIER');
  });

  it('counts characters, not bytes, so a Twi or emoji passphrase is measured fairly', () => {
    expect(checkPasswordShape('Ɛyɛ-dɛ-paa-ɔ', 'x@hakoremfarms.com')).toBeNull();
  });
});

describe('login identifiers (FR-IAM-001)', () => {
  it('lower-cases and trims an email address', () => {
    expect(normaliseIdentifier('  Adwoa.Darko@HaKoremFarms.com ')).toEqual({ kind: 'EMAIL', value: 'adwoa.darko@hakoremfarms.com' });
  });

  it('takes a phone number in E.164 form', () => {
    expect(normaliseIdentifier('+233244512876')).toEqual({ kind: 'PHONE', value: '+233244512876' });
  });

  it('refuses anything else without saying whether an account exists', () => {
    expect(normaliseIdentifier('0244512876')).toBeNull();
    expect(normaliseIdentifier('adwoa')).toBeNull();
  });
});

describe('refresh lifetimes (ADR-0016, A-065)', () => {
  const created = new Date('2026-11-14T06:00:00Z');

  it('extends the idle lifetime from each use, never beyond the absolute lifetime', () => {
    expect(refreshExpiry(created, created, staff)).toEqual({
      idleExpiresAt: new Date('2026-11-14T18:00:00Z'),
      absoluteExpiresAt: new Date('2026-11-21T06:00:00Z'),
    });
    const lastDay = new Date('2026-11-21T00:00:00Z');
    expect(refreshExpiry(created, lastDay, staff).idleExpiresAt).toEqual(new Date('2026-11-21T06:00:00Z'));
  });

  it('covers an eight-hour offline shift with the staff idle lifetime', () => {
    const shiftEnd = new Date(created.getTime() + 8 * 3_600_000);
    expect(refreshExpiry(created, created, staff).idleExpiresAt.getTime()).toBeGreaterThan(shiftEnd.getTime());
  });
});
