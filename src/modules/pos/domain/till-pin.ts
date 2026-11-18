/**
 * The till PIN (CR-032, the owner on 2026-11-17 and 2026-11-18, ADR-0080). The PIN unlocks a till and approves on it;
 * it never authenticates to the server. The till derives the verifier from the PIN it is typed into and sends only the
 * verifier; the server checks its parameters, counts the wrong tries the tills report, and checks every approval made
 * with a PIN against the version it was made with. Pure: every time is passed in (ADR-0067).
 */

/** The only derivation the server takes: PBKDF2 with HMAC-SHA256 over the PIN's UTF-8 bytes. */
export const PIN_ALGORITHM = 'PBKDF2-SHA256';
/** The owner's floor (2026-11-17): never fewer. */
export const PIN_MIN_ITERATIONS = 600_000;
/** A ceiling, so a verifier cannot make every till that checks it hang (about 15 seconds on a slow tablet). */
export const PIN_MAX_ITERATIONS = 10_000_000;
/** The owner's floor (2026-11-17): a random salt of at least 16 bytes per person. */
export const PIN_MIN_SALT_BYTES = 16;
export const PIN_MAX_SALT_BYTES = 64;
/** SHA-256's output length, the derived key the till stores and compares. */
export const PIN_HASH_BYTES = 32;
/** The owner's rule: at most five wrong tries, then the PIN is locked until its owner sets a new one. */
export const PIN_MAX_WRONG_TRIES = 5;

export interface PinVerifierInput {
  readonly algorithm: string;
  readonly iterations: number;
  readonly salt: Uint8Array;
  readonly hash: Uint8Array;
}

export interface PinRule {
  readonly field: string;
  readonly rule: string;
}

/** What makes a verifier weaker than the owner's rules (refused, never stored). */
export function judgePinVerifier(v: PinVerifierInput): PinRule[] {
  const broken: PinRule[] = [];
  if (v.algorithm !== PIN_ALGORITHM) broken.push({ field: '/algorithm', rule: 'PIN_ALGORITHM_NOT_ALLOWED' });
  if (v.iterations < PIN_MIN_ITERATIONS) broken.push({ field: '/iterations', rule: 'PIN_ITERATIONS_TOO_FEW' });
  else if (v.iterations > PIN_MAX_ITERATIONS) broken.push({ field: '/iterations', rule: 'PIN_ITERATIONS_TOO_MANY' });
  if (v.salt.length < PIN_MIN_SALT_BYTES) broken.push({ field: '/salt', rule: 'PIN_SALT_TOO_SHORT' });
  else if (v.salt.length > PIN_MAX_SALT_BYTES) broken.push({ field: '/salt', rule: 'PIN_SALT_TOO_LONG' });
  else if (v.salt.every((b) => b === v.salt[0])) broken.push({ field: '/salt', rule: 'PIN_SALT_NOT_RANDOM' });
  if (v.hash.length !== PIN_HASH_BYTES) broken.push({ field: '/hash', rule: 'PIN_HASH_NOT_32_BYTES' });
  return broken;
}

/** A PIN with five wrong tries counted against its version is locked; a success does not wipe a wrong try (A-280 (c)). */
export function pinLocked(wrongTries: number): boolean {
  return wrongTries >= PIN_MAX_WRONG_TRIES;
}

/** The wrong tries made at or before a moment, by the till time each was made at. */
export function wrongTriesBefore(triedAt: readonly Date[], moment: Date): number {
  return triedAt.filter((t) => t.getTime() <= moment.getTime()).length;
}

/** How an event the till sends again is answered: decided once by its client id, forever. */
export function pinEventAnswer(prior: { readonly sameContent: boolean } | null): 'NEW' | 'DUPLICATE' | 'ID_REUSED_WITH_OTHER_CONTENT' {
  if (prior === null) return 'NEW';
  return prior.sameContent ? 'DUPLICATE' : 'ID_REUSED_WITH_OTHER_CONTENT';
}

export interface PinApprovalFacts {
  readonly approverId: string;
  /** The verifier version the till checked the PIN against; null when the till sent none. */
  readonly pinVersion: number | null;
  /** The person whose drawer or sale it is. */
  readonly cashierId: string;
  /** Who sends it, where the approver must not be them too (a drop's witness); null where that does not apply. */
  readonly actorId: string | null;
  /** The approver holds the supervising permission at the branch now. */
  readonly approverIsSupervisor: boolean;
  /** The approver's verifier of that version as the server holds it; null when it holds none. */
  readonly verifier: { readonly version: number; readonly supersededAt: Date | null; readonly wrongTriesBefore: number } | null;
  /** When the approval was given (the till's time). */
  readonly at: Date;
}

export type PinApprovalVerdict = 'VERIFIED' | 'PIN_NOT_SENT' | 'APPROVER_IS_MAKER' | 'APPROVER_NOT_SUPERVISOR' | 'PIN_UNKNOWN' | 'PIN_SUPERSEDED' | 'PIN_LOCKED';

/**
 * Whether an approval given with a PIN on the till stands (CR-032 point 4): a supervisor of the branch who is not the
 * maker, with a PIN version the server holds, not replaced by a newer one and not locked when the approval was given.
 * A named supervisor without a PIN version is not an approval (the owner on 2026-11-18).
 */
export function judgePinApproval(f: PinApprovalFacts): PinApprovalVerdict {
  if (f.pinVersion === null) return 'PIN_NOT_SENT';
  if (f.approverId === f.cashierId || f.approverId === f.actorId) return 'APPROVER_IS_MAKER';
  if (!f.approverIsSupervisor) return 'APPROVER_NOT_SUPERVISOR';
  if (f.verifier === null) return 'PIN_UNKNOWN';
  if (f.verifier.supersededAt !== null && f.verifier.supersededAt.getTime() <= f.at.getTime()) return 'PIN_SUPERSEDED';
  if (pinLocked(f.verifier.wrongTriesBefore)) return 'PIN_LOCKED';
  return 'VERIFIED';
}

export type SignOutRule = 'SUPERVISOR_IS_CASHIER' | 'SUPERVISOR_NOT_SUPERVISOR' | 'CASHIER_NOT_LOCKED' | `SUPERVISOR_${Exclude<PinApprovalVerdict, 'VERIFIED'>}`;

/**
 * Signing a locked cashier out of a till (CR-032, the owner on 2026-11-17): only once the cashier's PIN is locked, only
 * by a supervisor of the branch who is not that cashier, and only with that supervisor's PIN verified.
 */
export function judgeSignOut(f: {
  readonly cashierId: string;
  readonly supervisorId: string;
  readonly supervisorIsSupervisor: boolean;
  readonly cashierLocked: boolean;
  readonly supervisorPin: PinApprovalVerdict;
}): SignOutRule[] {
  if (f.supervisorId === f.cashierId) return ['SUPERVISOR_IS_CASHIER'];
  const broken: SignOutRule[] = [];
  if (!f.supervisorIsSupervisor) broken.push('SUPERVISOR_NOT_SUPERVISOR');
  if (!f.cashierLocked) broken.push('CASHIER_NOT_LOCKED');
  if (f.supervisorPin !== 'VERIFIED' && f.supervisorPin !== 'APPROVER_NOT_SUPERVISOR' && f.supervisorPin !== 'APPROVER_IS_MAKER') broken.push(`SUPERVISOR_${f.supervisorPin}`);
  return broken;
}

/**
 * The rule a cash drop breaks when its witness did not confirm it with a PIN the server holds in force (the owner on
 * 2026-11-18: a named supervisor without their PIN is not a witness); null for a verified witness.
 */
export function witnessPinRule(verdict: PinApprovalVerdict): string | null {
  switch (verdict) {
    case 'VERIFIED':
      return null;
    case 'PIN_NOT_SENT':
      return 'WITNESS_PIN_REQUIRED';
    case 'APPROVER_IS_MAKER':
      return 'WITNESS_IS_MAKER';
    case 'APPROVER_NOT_SUPERVISOR':
      return 'WITNESS_NOT_SUPERVISOR';
    default:
      return `WITNESS_${verdict}`;
  }
}

/** Why a line's offline price is beyond what the cashier may give alone, as ORD's sale posting finds it. */
export type CashierOverrideFinding = 'OUTSIDE_BAND' | 'BEYOND_ROLE_LIMIT' | 'BEYOND_SHIFT_LIMIT' | null;

export interface OfflineOverrideVerdict {
  readonly severity: 'REVIEW' | 'URGENT';
  /** Within the cashier's own limit; over it with a supervisor's verified PIN; or outside the rules. */
  readonly basis: 'WITHIN_CASHIER_LIMIT' | 'SUPERVISOR_PIN' | 'OUTSIDE_RULES';
  readonly reason: string | null;
}

/**
 * How an offline price override is raised at sync (the owner on 2026-11-18, replacing A-278 (h)): every difference from
 * the server's price reaches the exception report's source, and the price charged always stands. Within the cashier's own
 * limit it is for review; beyond it, it is URGENT, and it stands on the rules only with a supervisor's PIN verified at
 * sync and a variance within that supervisor's own line limit. There is never an unlimited override offline: no PIN, a
 * PIN that is not a supervisor's, a variance beyond the supervisor's own limit, or a price outside the band is outside
 * the rules.
 */
export function offlineOverrideVerdict(f: {
  readonly beyondCashier: CashierOverrideFinding;
  readonly approval: PinApprovalVerdict | null;
  readonly variancePesewas: bigint;
  readonly supervisorLineLimitPesewas: bigint;
}): OfflineOverrideVerdict {
  const outside = (reason: string): OfflineOverrideVerdict => ({ severity: 'URGENT', basis: 'OUTSIDE_RULES', reason });
  if (f.beyondCashier === null) return { severity: 'REVIEW', basis: 'WITHIN_CASHIER_LIMIT', reason: null };
  if (f.beyondCashier === 'OUTSIDE_BAND') return outside('OUTSIDE_BAND');
  if (f.approval === null) return outside('NO_SUPERVISOR_PIN');
  if (f.approval !== 'VERIFIED') return outside(`SUPERVISOR_${f.approval}`);
  if (f.variancePesewas > f.supervisorLineLimitPesewas) return outside('BEYOND_SUPERVISOR_LIMIT');
  // Beyond the cashier's limit is URGENT whoever approved it (the owner's clarification, 2026-11-18); the basis says
  // it stands on a supervisor's PIN rather than outside the rules.
  return { severity: 'URGENT', basis: 'SUPERVISOR_PIN', reason: null };
}
