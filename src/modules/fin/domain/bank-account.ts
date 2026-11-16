import { err, ok, type Result } from '@hakorem/kernel';

/** The kinds of the business's own accounts (`fin.bank_account.kind`). */
export type BankAccountKind = 'BANK' | 'MOBILE_MONEY';

/** How a supplier payment leaves the farm (`pur.supplier_payment.method`). */
export type PayoutMethod = 'BANK' | 'MOBILE_MONEY' | 'CASH' | 'CHEQUE';

export interface BankAccountRule {
  readonly field: string;
  readonly rule: 'ACCOUNT_NUMBER_INVALID' | 'MOMO_NUMBER_INVALID' | 'NAME_TAKEN';
}

const SEPARATORS = /[\s-]/g;
const BANK_NUMBER = /^[0-9]{6,20}$/;
const MOMO_E164 = /^\+233([0-9]{9})$/;
const MOMO_NATIONAL = /^0([0-9]{9})$/;
const LAST_DIGITS = 4;

/** The control account each kind posts to (ADR-0003; the database holds it too, `ck_bank_account_gl`). */
const GL_CODE: Readonly<Record<BankAccountKind, string>> = { BANK: '1100', MOBILE_MONEY: '1110' };

/**
 * The number as it is sealed, and the last four digits that are all that ever leaves FIN (ADR-0057, A-194). A bank
 * number is 6 to 20 digits; a wallet number a Ghana mobile number, kept in E.164 (+233 and nine digits). Spaces and
 * dashes are dropped. The refusal names only the rule, never the value.
 */
export function normaliseAccountNo(kind: BankAccountKind, raw: string): Result<{ readonly accountNo: string; readonly last4: string }, BankAccountRule> {
  const compact = raw.replace(SEPARATORS, '');
  if (kind === 'BANK') {
    return BANK_NUMBER.test(compact) ? ok({ accountNo: compact, last4: compact.slice(-LAST_DIGITS) }) : err({ field: '/accountNo', rule: 'ACCOUNT_NUMBER_INVALID' });
  }
  const digits = MOMO_E164.exec(compact)?.[1] ?? MOMO_NATIONAL.exec(compact)?.[1];
  if (digits === undefined) {
    return err({ field: '/accountNo', rule: 'MOMO_NUMBER_INVALID' });
  }
  return ok({ accountNo: `+233${digits}`, last4: digits.slice(-LAST_DIGITS) });
}

export function glCodeOf(kind: BankAccountKind): string {
  return GL_CODE[kind];
}

/** The kind of account a payment method leaves from: a bank for a transfer or a cheque, a wallet for mobile money, none for cash. */
export function bankAccountKindFor(method: PayoutMethod): BankAccountKind | null {
  switch (method) {
    case 'BANK':
    case 'CHEQUE':
      return 'BANK';
    case 'MOBILE_MONEY':
      return 'MOBILE_MONEY';
    case 'CASH':
      return null;
  }
}

/**
 * Whether a supplier payment may name this account (A-185, A-194): naming none is always allowed (A-185 then posts it
 * to the "not yet named" party); one it names must exist, be active and be of the kind its method leaves from, so a
 * cash payment names none.
 */
export function judgePayoutAccount(
  method: PayoutMethod,
  account: { readonly kind: BankAccountKind; readonly isActive: boolean } | 'UNKNOWN' | null,
): Result<void, 'BANK_ACCOUNT_NOT_AVAILABLE'> {
  if (account === null) {
    return ok(undefined);
  }
  if (account === 'UNKNOWN' || !account.isActive || account.kind !== bankAccountKindFor(method)) {
    return err('BANK_ACCOUNT_NOT_AVAILABLE');
  }
  return ok(undefined);
}
