import { err, ok, type Result } from '@hakorem/kernel';

/**
 * Settlement and bank reconciliation (FR-PAY-016, FR-PAY-017, ADR-0065): reading the provider's settlement file and the
 * bank's statement file, matching their lines, and judging how a break may be resolved. Pure: no I/O, no framework.
 * Reconciliation never corrects: a line that does not match exactly, or matches more than one thing, is a break for a
 * person, and a break is resolved only through a second person's approval.
 */

/** A rule a file breaks, at a row: row 1 is the header, row 0 the request itself. */
export interface FileRefusal {
  readonly row: number;
  readonly rule: string;
}

const CEDIS = /^(\d{1,14})\.(\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SETTLEMENT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,59}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const TEXT_MAX = 200;
/** The largest amount a `platform.pesewas` column holds (2^53 - 1, ADR-0001). */
const MAX_PESEWAS = 9_007_199_254_740_991n;
/** A reference shorter than this, once spaces and punctuation are taken out, identifies nothing. */
const MIN_REFERENCE_CHARACTERS = 4;

/** An amount in cedis written with exactly two places (`1500.00`), as integer pesewas; null for anything else. */
export function parseCedis(text: string): bigint | null {
  const match = CEDIS.exec(text);
  if (match === null) return null;
  const pesewas = BigInt(match[1]!) * 100n + BigInt(match[2]!);
  return pesewas > MAX_PESEWAS ? null : pesewas;
}

function isDate(text: string): boolean {
  if (!DATE.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function headerIs(row: readonly string[] | undefined, expected: readonly string[]): boolean {
  return row !== undefined && row.length >= expected.length && expected.every((name, i) => row[i]!.trim().toLowerCase() === name);
}

const SETTLEMENT_COLUMNS = ['settlement_ref', 'settled_on', 'reference', 'amount', 'fee'] as const;
const STATEMENT_COLUMNS = ['value_date', 'direction', 'amount', 'balance', 'reference', 'narration'] as const;

export interface SettlementFileLine {
  readonly lineNo: number;
  readonly reference: string;
  readonly amountPesewas: bigint;
  readonly feePesewas: bigint;
}

export interface SettlementFile {
  readonly settlementRef: string;
  readonly settledOn: string;
  readonly grossPesewas: bigint;
  readonly feePesewas: bigint;
  readonly netPesewas: bigint;
  readonly lines: readonly SettlementFileLine[];
}

/**
 * A provider settlement file (A-214): a header `settlement_ref,settled_on,reference,amount,fee` and one row per
 * transaction the provider paid out, all of one settlement on one date no later than today; amounts in cedis with two
 * places; each reference once; a fee never above its amount. Every broken row is named at once.
 */
export function readSettlementFile(rows: readonly (readonly string[])[], today: string): Result<SettlementFile, FileRefusal[]> {
  if (!headerIs(rows[0], SETTLEMENT_COLUMNS)) return err([{ row: 1, rule: 'HEADER_MISMATCH' }]);
  if (rows.length === 1) return err([{ row: 1, rule: 'NO_LINES' }]);
  const refusals: FileRefusal[] = [];
  const lines: SettlementFileLine[] = [];
  const seen = new Set<string>();
  const first = rows[1]!;
  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i]!.map((c) => c.trim());
    const row = i + 1;
    if (cells.length < SETTLEMENT_COLUMNS.length) {
      refusals.push({ row, rule: 'COLUMNS_MISSING' });
      continue;
    }
    const [settlementRef, settledOn, reference, amountText, feeText] = cells as [string, string, string, string, string];
    if (!SETTLEMENT_REF.test(settlementRef)) refusals.push({ row, rule: 'SETTLEMENT_REF_INVALID' });
    else if (settlementRef !== first[0]!.trim()) refusals.push({ row, rule: 'SETTLEMENT_REF_MIXED' });
    if (!isDate(settledOn)) refusals.push({ row, rule: 'SETTLED_ON_INVALID' });
    else if (settledOn !== first[1]!.trim()) refusals.push({ row, rule: 'SETTLED_ON_MIXED' });
    else if (settledOn > today) refusals.push({ row, rule: 'SETTLED_ON_IN_FUTURE' });
    const amount = parseCedis(amountText);
    const fee = parseCedis(feeText);
    if (amount === null) refusals.push({ row, rule: 'AMOUNT_INVALID' });
    else if (amount === 0n) refusals.push({ row, rule: 'AMOUNT_NOT_POSITIVE' });
    if (!REFERENCE.test(reference)) refusals.push({ row, rule: 'REFERENCE_INVALID' });
    else if (seen.has(reference)) refusals.push({ row, rule: 'REFERENCE_REPEATED' });
    seen.add(reference);
    if (fee === null) refusals.push({ row, rule: 'FEE_INVALID' });
    else if (amount !== null && fee > amount) refusals.push({ row, rule: 'FEE_EXCEEDS_AMOUNT' });
    if (amount !== null && fee !== null) lines.push({ lineNo: i, reference, amountPesewas: amount, feePesewas: fee });
  }
  if (refusals.length > 0) return err(refusals);
  const gross = lines.reduce((sum, l) => sum + l.amountPesewas, 0n);
  const fee = lines.reduce((sum, l) => sum + l.feePesewas, 0n);
  return ok({ settlementRef: first[0]!.trim(), settledOn: first[1]!.trim(), grossPesewas: gross, feePesewas: fee, netPesewas: gross - fee, lines });
}

export type SettlementMatch =
  | { readonly status: 'MATCHED'; readonly reason: null }
  | { readonly status: 'AMOUNT_DIFFERS'; readonly reason: 'AMOUNT_DIFFERS' }
  | { readonly status: 'NOT_FOUND'; readonly reason: 'NO_PAYMENT' | 'NOT_CLEARED' | 'ALREADY_SETTLED' };

/** The payment a settlement line's reference names, as far as matching reads it. */
export interface SettlementCandidate {
  readonly status: string;
  readonly provider: string | null;
  readonly amountPesewas: bigint;
  /** True when a line of another settlement already matched it: a payment is settled once. */
  readonly alreadySettled: boolean;
}

/**
 * One settlement line against the payment its reference names (FR-PAY-016): matched only to a cleared payment of the
 * same provider for exactly its amount. A payment the provider has not confirmed is never cleared from a settlement
 * file (FR-PAY-005): the line is not found and waits for the provider's own answer.
 */
export function matchSettlementLine(provider: string, line: { readonly amountPesewas: bigint }, payment: SettlementCandidate | null): SettlementMatch {
  if (payment === null || payment.provider !== provider) return { status: 'NOT_FOUND', reason: 'NO_PAYMENT' };
  if (payment.status !== 'CLEARED') return { status: 'NOT_FOUND', reason: 'NOT_CLEARED' };
  if (payment.alreadySettled) return { status: 'NOT_FOUND', reason: 'ALREADY_SETTLED' };
  if (payment.amountPesewas !== line.amountPesewas) return { status: 'AMOUNT_DIFFERS', reason: 'AMOUNT_DIFFERS' };
  return { status: 'MATCHED', reason: null };
}

/** What `pay.ProviderSettled` posts: the matched lines only, summed as integers. */
export function settlementPosting(lines: readonly { readonly status: string; readonly amountPesewas: bigint; readonly feePesewas: bigint }[]): { grossPesewas: bigint; feePesewas: bigint; netPesewas: bigint } {
  const matched = lines.filter((l) => l.status === 'MATCHED');
  const gross = matched.reduce((sum, l) => sum + l.amountPesewas, 0n);
  const fee = matched.reduce((sum, l) => sum + l.feePesewas, 0n);
  return { grossPesewas: gross, feePesewas: fee, netPesewas: gross - fee };
}

export type Direction = 'IN' | 'OUT';

export interface StatementFileLine {
  readonly lineNo: number;
  readonly valueDate: string;
  readonly direction: Direction;
  readonly amountPesewas: bigint;
  readonly balancePesewas: bigint;
  readonly reference: string | null;
  readonly narration: string | null;
}

export interface StatementFile {
  readonly openingPesewas: bigint;
  readonly closingPesewas: bigint;
  readonly lines: readonly StatementFileLine[];
}

/**
 * A bank statement file (A-214): a header `value_date,direction,amount,balance,reference,narration` and one row per
 * line in the bank's order, each dated within the period, `IN` or `OUT`, its amount above zero and the balance after
 * it; the running balance must add up to the pesewa, and the opening it implies is never below zero. The period ends on
 * or before today and not before it starts.
 */
export function readStatementFile(rows: readonly (readonly string[])[], period: { readonly start: string; readonly end: string }, today: string): Result<StatementFile, FileRefusal[]> {
  if (period.end < period.start || period.end > today) return err([{ row: 0, rule: 'PERIOD_INVALID' }]);
  if (!headerIs(rows[0], STATEMENT_COLUMNS)) return err([{ row: 1, rule: 'HEADER_MISMATCH' }]);
  if (rows.length === 1) return err([{ row: 1, rule: 'NO_LINES' }]);
  const refusals: FileRefusal[] = [];
  const lines: StatementFileLine[] = [];
  let previous: bigint | null = null;
  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i]!.map((c) => c.trim());
    const row = i + 1;
    if (cells.length < STATEMENT_COLUMNS.length) {
      refusals.push({ row, rule: 'COLUMNS_MISSING' });
      previous = null;
      continue;
    }
    const [valueDate, direction, amountText, balanceText, reference, narration] = cells as [string, string, string, string, string, string];
    if (!isDate(valueDate) || valueDate < period.start || valueDate > period.end) refusals.push({ row, rule: 'VALUE_DATE_OUT_OF_PERIOD' });
    if (direction !== 'IN' && direction !== 'OUT') refusals.push({ row, rule: 'DIRECTION_INVALID' });
    const amount = parseCedis(amountText);
    const balance = parseCedis(balanceText);
    if (amount === null) refusals.push({ row, rule: 'AMOUNT_INVALID' });
    else if (amount === 0n) refusals.push({ row, rule: 'AMOUNT_NOT_POSITIVE' });
    if (balance === null) refusals.push({ row, rule: 'BALANCE_INVALID' });
    if (reference.length > TEXT_MAX || narration.length > TEXT_MAX) refusals.push({ row, rule: 'TEXT_TOO_LONG' });
    if (amount === null || balance === null || (direction !== 'IN' && direction !== 'OUT')) {
      previous = null;
      continue;
    }
    const before = direction === 'IN' ? balance - amount : balance + amount;
    if (previous === null && i === 1 && before < 0n) refusals.push({ row, rule: 'OPENING_NEGATIVE' });
    if (previous !== null && before !== previous) refusals.push({ row, rule: 'BALANCE_BROKEN' });
    previous = balance;
    lines.push({ lineNo: i, valueDate, direction, amountPesewas: amount, balancePesewas: balance, reference: reference === '' ? null : reference, narration: narration === '' ? null : narration });
  }
  if (refusals.length > 0) return err(refusals);
  const first = lines[0]!;
  return ok({ openingPesewas: first.direction === 'IN' ? first.balancePesewas - first.amountPesewas : first.balancePesewas + first.amountPesewas, closingPesewas: lines.at(-1)!.balancePesewas, lines });
}

/** Something a statement line may match automatically: a pending bank transfer, or a settlement's payout. */
export interface BankCandidate {
  readonly id: string;
  readonly reference: string;
  readonly amountPesewas: bigint;
}

export type BankChoice = { readonly kind: 'MATCH'; readonly candidateId: string } | { readonly kind: 'BREAK'; readonly reason: 'NO_CANDIDATE' | 'AMOUNT_DIFFERS' | 'CANDIDATES_TIE' };

const normalised = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * What a statement line matches automatically (FR-PAY-011, FR-PAY-016; the owner, 2026-11-16): never on amount alone.
 * A candidate counts only when the line's reference or narration carries its reference; exactly one such candidate at
 * exactly the line's amount is a match; two are a tie and a break; the right reference at another amount is a break.
 * Money going out is matched by hand.
 */
export function chooseBankCandidate(line: { readonly direction: Direction; readonly amountPesewas: bigint; readonly reference: string | null; readonly narration: string | null }, candidates: readonly BankCandidate[]): BankChoice {
  if (line.direction === 'OUT') return { kind: 'BREAK', reason: 'NO_CANDIDATE' };
  const text = normalised(`${line.reference ?? ''} ${line.narration ?? ''}`);
  const referenced = candidates.filter((c) => {
    const reference = normalised(c.reference);
    return reference.length >= MIN_REFERENCE_CHARACTERS && text.includes(reference);
  });
  const exact = referenced.filter((c) => c.amountPesewas === line.amountPesewas);
  if (exact.length === 1) return { kind: 'MATCH', candidateId: exact[0]!.id };
  if (exact.length > 1) return { kind: 'BREAK', reason: 'CANDIDATES_TIE' };
  return { kind: 'BREAK', reason: referenced.length > 0 ? 'AMOUNT_DIFFERS' : 'NO_CANDIDATE' };
}

export type LineMatchTarget =
  | {
      readonly kind: 'PAYMENT';
      readonly methodKind: string;
      readonly status: string;
      readonly sameBankAccount: boolean;
      readonly amountPesewas: bigint;
      readonly alreadyMatched: boolean;
    }
  | {
      readonly kind: 'JOURNAL';
      /** The entry's net leg on this bank account's party (debit for money in), null when it has none. */
      readonly leg: { readonly side: 'D' | 'C'; readonly amountPesewas: bigint } | null;
      readonly alreadyMatched: boolean;
    };

export type LineMatchRefusal =
  | 'LINE_ALREADY_MATCHED'
  | 'NOT_A_PENDING_TRANSFER'
  | 'OTHER_BANK_ACCOUNT'
  | 'DIRECTION_DIFFERS'
  | 'AMOUNT_DIFFERS'
  | 'ENTRY_HAS_NO_BANK_LEG'
  | 'TARGET_ALREADY_MATCHED';

/**
 * A statement line matched by hand (`matchBankStatementLine`): to a bank transfer still pending into the same account
 * for exactly its amount (which clears it), or to a journal entry whose leg on this account is on the line's side for
 * exactly its amount. Each line and each target is matched once.
 */
export function judgeLineMatch(line: { readonly direction: Direction; readonly amountPesewas: bigint; readonly matched: boolean }, target: LineMatchTarget): Result<void, LineMatchRefusal[]> {
  if (line.matched) return err(['LINE_ALREADY_MATCHED']);
  if (target.alreadyMatched) return err(['TARGET_ALREADY_MATCHED']);
  if (target.kind === 'PAYMENT') {
    if (target.methodKind !== 'BANK_TRANSFER' || target.status !== 'PENDING') return err(['NOT_A_PENDING_TRANSFER']);
    if (!target.sameBankAccount) return err(['OTHER_BANK_ACCOUNT']);
    if (line.direction !== 'IN') return err(['DIRECTION_DIFFERS']);
    if (target.amountPesewas !== line.amountPesewas) return err(['AMOUNT_DIFFERS']);
    return ok(undefined);
  }
  if (target.leg === null) return err(['ENTRY_HAS_NO_BANK_LEG']);
  if (target.leg.side !== (line.direction === 'IN' ? 'D' : 'C')) return err(['DIRECTION_DIFFERS']);
  if (target.leg.amountPesewas !== line.amountPesewas) return err(['AMOUNT_DIFFERS']);
  return ok(undefined);
}

export type ResolutionPosting = 'NONE' | 'UNIDENTIFIED_RECEIPT';
export type ResolutionRefusal = 'BREAK_NOT_OPEN' | 'NOTE_REQUIRED' | 'POSTING_NOT_FOR_BREAK' | 'LINE_ALREADY_MATCHED';

/** A break as its resolution reads it, with the reconciliation line it was raised for, if any. */
export interface ResolvableBreak {
  readonly status: 'OPEN' | 'RESOLVED';
  readonly kind: string;
  readonly line: { readonly source: 'SETTLEMENT' | 'BANK'; readonly reason: string | null; readonly direction: Direction; readonly matched: boolean } | null;
}

/**
 * How a break may be resolved (FR-PAY-017): only while open, always with a note, always through a second person's
 * approval. Its one posting is the unidentified receipt (FR-PAY-010): money that reached the bank from a payer nobody
 * can name, held in 2290: a settlement line whose reference no payment of ours carries, or money in on a statement
 * line nothing matched. Anything else is resolved with a note after the correction was made through its own operation
 * (an allocation, a refund, a reversal, a match by hand, an approved manual journal).
 */
export function judgeResolution(b: ResolvableBreak, posting: ResolutionPosting, note: string): Result<void, ResolutionRefusal[]> {
  if (b.status !== 'OPEN') return err(['BREAK_NOT_OPEN']);
  if (note.trim() === '') return err(['NOTE_REQUIRED']);
  if (posting === 'NONE') return ok(undefined);
  const line = b.line;
  const unknownPayer =
    line !== null &&
    line.direction === 'IN' &&
    ((b.kind === 'SETTLEMENT_NOT_FOUND' && line.source === 'SETTLEMENT' && line.reason === 'NO_PAYMENT') || (b.kind === 'BANK_LINE_UNMATCHED' && line.source === 'BANK'));
  if (!unknownPayer) return err(['POSTING_NOT_FOR_BREAK']);
  if (line.matched) return err(['LINE_ALREADY_MATCHED']);
  return ok(undefined);
}
