import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  judgePinApproval,
  judgePinVerifier,
  judgeSignOut,
  pinEventAnswer,
  pinLocked,
  PIN_ALGORITHM,
  PIN_HASH_BYTES,
  PIN_MAX_ITERATIONS,
  PIN_MAX_WRONG_TRIES,
  PIN_MIN_ITERATIONS,
  PIN_MIN_SALT_BYTES,
  offlineOverrideVerdict,
  witnessPinRule,
  wrongTriesBefore,
  type PinApprovalFacts,
} from './till-pin';

const at = (iso: string) => new Date(iso);

describe('a till PIN verifier (CR-032, the owner on 2026-11-17)', () => {
  it('names the owner parameters exactly: PBKDF2-SHA256, at least 600,000 iterations, a 16-byte salt, a 32-byte hash, five wrong tries', () => {
    expect(PIN_ALGORITHM).toBe('PBKDF2-SHA256');
    expect(PIN_MIN_ITERATIONS).toBe(600_000);
    expect(PIN_MIN_SALT_BYTES).toBe(16);
    expect(PIN_HASH_BYTES).toBe(32);
    expect(PIN_MAX_WRONG_TRIES).toBe(5);
    expect(PIN_MAX_ITERATIONS).toBe(10_000_000);
  });

  it('takes a verifier the till derived by the owner rules', () => {
    const salt = randomBytes(16);
    const hash = pbkdf2Sync('482915', salt, 600_000, 32, 'sha256');
    expect(judgePinVerifier({ algorithm: 'PBKDF2-SHA256', iterations: 600_000, salt, hash })).toEqual([]);
    expect(judgePinVerifier({ algorithm: 'PBKDF2-SHA256', iterations: 10_000_000, salt: randomBytes(64), hash })).toEqual([]);
  });

  it('refuses a weaker verifier: 599,999 iterations, a 15-byte salt, another algorithm, a hash not 32 bytes', () => {
    const hash = randomBytes(32);
    expect(judgePinVerifier({ algorithm: 'PBKDF2-SHA256', iterations: 599_999, salt: randomBytes(16), hash })).toEqual([{ field: '/iterations', rule: 'PIN_ITERATIONS_TOO_FEW' }]);
    expect(judgePinVerifier({ algorithm: 'PBKDF2-SHA256', iterations: 600_000, salt: randomBytes(15), hash })).toEqual([{ field: '/salt', rule: 'PIN_SALT_TOO_SHORT' }]);
    expect(judgePinVerifier({ algorithm: 'PBKDF2-SHA1', iterations: 600_000, salt: randomBytes(16), hash })).toEqual([{ field: '/algorithm', rule: 'PIN_ALGORITHM_NOT_ALLOWED' }]);
    expect(judgePinVerifier({ algorithm: 'PBKDF2-SHA256', iterations: 600_000, salt: randomBytes(16), hash: randomBytes(31) })).toEqual([{ field: '/hash', rule: 'PIN_HASH_NOT_32_BYTES' }]);
  });

  it('refuses a cost the till cannot afford and a salt beyond 64 bytes', () => {
    expect(judgePinVerifier({ algorithm: 'PBKDF2-SHA256', iterations: 10_000_001, salt: randomBytes(65), hash: randomBytes(32) })).toEqual([
      { field: '/iterations', rule: 'PIN_ITERATIONS_TOO_MANY' },
      { field: '/salt', rule: 'PIN_SALT_TOO_LONG' },
    ]);
  });

  it('refuses a salt that is all one byte, which no secure generator gives', () => {
    expect(judgePinVerifier({ algorithm: 'PBKDF2-SHA256', iterations: 600_000, salt: Buffer.alloc(16, 7), hash: randomBytes(32) })).toEqual([{ field: '/salt', rule: 'PIN_SALT_NOT_RANDOM' }]);
  });
});

describe('the wrong tries that lock a PIN (CR-032 point 3, enforced on the server too)', () => {
  it('locks at the fifth wrong try and not at the fourth', () => {
    expect(pinLocked(4)).toBe(false);
    expect(pinLocked(5)).toBe(true);
    expect(pinLocked(6)).toBe(true);
  });

  it('counts the wrong tries made before a moment, by the till time each was made', () => {
    const tries = [at('2026-11-13T09:00:00Z'), at('2026-11-13T09:01:00Z'), at('2026-11-13T11:00:00Z')];
    expect(wrongTriesBefore(tries, at('2026-11-13T09:01:00Z'))).toBe(2);
    expect(wrongTriesBefore(tries, at('2026-11-13T08:59:59Z'))).toBe(0);
    expect(wrongTriesBefore(tries, at('2026-11-13T12:00:00Z'))).toBe(3);
  });
});

describe('an event sent again (exactly once by its client id)', () => {
  it('is new the first time, a duplicate with the same content, and refused under the same id with other content', () => {
    expect(pinEventAnswer(null)).toBe('NEW');
    expect(pinEventAnswer({ sameContent: true })).toBe('DUPLICATE');
    expect(pinEventAnswer({ sameContent: false })).toBe('ID_REUSED_WITH_OTHER_CONTENT');
  });
});

describe('an approval made with a PIN on the till, checked on the server (CR-032 point 4)', () => {
  const base: PinApprovalFacts = {
    approverId: 'sup',
    pinVersion: 2,
    cashierId: 'cash',
    actorId: 'cash',
    approverIsSupervisor: true,
    verifier: { version: 2, supersededAt: null, wrongTriesBefore: 0 },
    at: at('2026-11-13T10:00:00Z'),
  };

  it('verifies a supervisor whose PIN version is in force and not locked', () => {
    expect(judgePinApproval(base)).toBe('VERIFIED');
    expect(judgePinApproval({ ...base, verifier: { version: 2, supersededAt: at('2026-11-13T10:00:01Z'), wrongTriesBefore: 4 } })).toBe('VERIFIED');
  });

  it('refuses an approval with no PIN version: a named supervisor without a PIN is not a witness', () => {
    expect(judgePinApproval({ ...base, pinVersion: null })).toBe('PIN_NOT_SENT');
  });

  it('refuses the cashier and the caller approving their own drawer', () => {
    expect(judgePinApproval({ ...base, approverId: 'cash' })).toBe('APPROVER_IS_MAKER');
    expect(judgePinApproval({ ...base, cashierId: 'other', actorId: 'sup' })).toBe('APPROVER_IS_MAKER');
  });

  it('refuses someone who is not a supervisor at the branch', () => {
    expect(judgePinApproval({ ...base, approverIsSupervisor: false })).toBe('APPROVER_NOT_SUPERVISOR');
  });

  it('refuses a PIN version the server does not hold, one replaced before the approval, and one locked before it', () => {
    expect(judgePinApproval({ ...base, verifier: null })).toBe('PIN_UNKNOWN');
    expect(judgePinApproval({ ...base, verifier: { version: 2, supersededAt: at('2026-11-13T10:00:00Z'), wrongTriesBefore: 0 } })).toBe('PIN_SUPERSEDED');
    expect(judgePinApproval({ ...base, verifier: { version: 2, supersededAt: null, wrongTriesBefore: 5 } })).toBe('PIN_LOCKED');
  });
});

describe('a locked cashier signed out on the till (CR-032, the owner on 2026-11-17)', () => {
  const base = { cashierId: 'cash', supervisorId: 'sup', supervisorIsSupervisor: true, cashierLocked: true, supervisorPin: 'VERIFIED' as const };

  it('is signed out by a different supervisor whose PIN verified', () => {
    expect(judgeSignOut(base)).toEqual([]);
  });

  it('refuses the cashier signing themselves out', () => {
    expect(judgeSignOut({ ...base, supervisorId: 'cash' })).toEqual(['SUPERVISOR_IS_CASHIER']);
  });

  it('refuses someone who is not a supervisor, a cashier who is not locked, and a supervisor PIN that did not verify', () => {
    expect(judgeSignOut({ ...base, supervisorIsSupervisor: false, cashierLocked: false, supervisorPin: 'PIN_LOCKED' })).toEqual(['SUPERVISOR_NOT_SUPERVISOR', 'CASHIER_NOT_LOCKED', 'SUPERVISOR_PIN_LOCKED']);
  });

  it('names a non-supervisor once, whether the PIN check or the grant read found it', () => {
    expect(judgeSignOut({ ...base, supervisorIsSupervisor: false, supervisorPin: 'APPROVER_NOT_SUPERVISOR' })).toEqual(['SUPERVISOR_NOT_SUPERVISOR']);
    expect(judgeSignOut({ ...base, supervisorPin: 'APPROVER_IS_MAKER' })).toEqual([]);
  });
});

describe('a drop witness checked by their PIN (the owner on 2026-11-18)', () => {
  it('names the rule a drop breaks for each verdict, and none for a verified witness', () => {
    expect(witnessPinRule('VERIFIED')).toBeNull();
    expect(witnessPinRule('PIN_NOT_SENT')).toBe('WITNESS_PIN_REQUIRED');
    expect(witnessPinRule('APPROVER_IS_MAKER')).toBe('WITNESS_IS_MAKER');
    expect(witnessPinRule('APPROVER_NOT_SUPERVISOR')).toBe('WITNESS_NOT_SUPERVISOR');
    expect(witnessPinRule('PIN_UNKNOWN')).toBe('WITNESS_PIN_UNKNOWN');
    expect(witnessPinRule('PIN_SUPERSEDED')).toBe('WITNESS_PIN_SUPERSEDED');
    expect(witnessPinRule('PIN_LOCKED')).toBe('WITNESS_PIN_LOCKED');
  });
});

describe('an offline price override at sync (the owner on 2026-11-18, replacing A-278 (h))', () => {
  it('raises an override within the cashier\'s own limit for review', () => {
    expect(offlineOverrideVerdict({ beyondCashier: null, approval: null, variancePesewas: 5_000n, supervisorLineLimitPesewas: 0n })).toEqual({ severity: 'REVIEW', basis: 'WITHIN_CASHIER_LIMIT', reason: null });
  });

  it('raises one over the cashier\'s limit with no supervisor PIN as urgent, one pesewa over included', () => {
    expect(offlineOverrideVerdict({ beyondCashier: 'BEYOND_ROLE_LIMIT', approval: null, variancePesewas: 5_001n, supervisorLineLimitPesewas: 20_000n })).toEqual({ severity: 'URGENT', basis: 'OUTSIDE_RULES', reason: 'NO_SUPERVISOR_PIN' });
  });

  it('raises one over the limit as urgent even when a verified supervisor PIN approved it within the supervisor\'s own limit, on that basis', () => {
    expect(offlineOverrideVerdict({ beyondCashier: 'BEYOND_ROLE_LIMIT', approval: 'VERIFIED', variancePesewas: 5_001n, supervisorLineLimitPesewas: 20_000n })).toEqual({ severity: 'URGENT', basis: 'SUPERVISOR_PIN', reason: null });
    expect(offlineOverrideVerdict({ beyondCashier: 'BEYOND_SHIFT_LIMIT', approval: 'VERIFIED', variancePesewas: 20_000n, supervisorLineLimitPesewas: 20_000n })).toEqual({ severity: 'URGENT', basis: 'SUPERVISOR_PIN', reason: null });
  });

  it('never allows an unlimited override: beyond the supervisor\'s own limit, outside the band, or a PIN that is not a supervisor\'s is urgent', () => {
    expect(offlineOverrideVerdict({ beyondCashier: 'BEYOND_ROLE_LIMIT', approval: 'VERIFIED', variancePesewas: 20_001n, supervisorLineLimitPesewas: 20_000n })).toEqual({ severity: 'URGENT', basis: 'OUTSIDE_RULES', reason: 'BEYOND_SUPERVISOR_LIMIT' });
    expect(offlineOverrideVerdict({ beyondCashier: 'OUTSIDE_BAND', approval: 'VERIFIED', variancePesewas: 1n, supervisorLineLimitPesewas: 20_000n })).toEqual({ severity: 'URGENT', basis: 'OUTSIDE_RULES', reason: 'OUTSIDE_BAND' });
    expect(offlineOverrideVerdict({ beyondCashier: 'BEYOND_ROLE_LIMIT', approval: 'APPROVER_NOT_SUPERVISOR', variancePesewas: 5_001n, supervisorLineLimitPesewas: 20_000n })).toEqual({ severity: 'URGENT', basis: 'OUTSIDE_RULES', reason: 'SUPERVISOR_APPROVER_NOT_SUPERVISOR' });
    expect(offlineOverrideVerdict({ beyondCashier: 'BEYOND_ROLE_LIMIT', approval: 'APPROVER_IS_MAKER', variancePesewas: 5_001n, supervisorLineLimitPesewas: 20_000n })).toEqual({ severity: 'URGENT', basis: 'OUTSIDE_RULES', reason: 'SUPERVISOR_APPROVER_IS_MAKER' });
  });
});
