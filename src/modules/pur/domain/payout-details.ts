import { err, ok, type Result } from '@hakorem/kernel';

/**
 * A supplier's payout details (FR-PUR-001, FR-PUR-002, ADR-0022). Restricted data: the application seals the judged
 * details with the supplier's key and keeps only the masked form in clear. Pure.
 */
export type PayoutMethod = 'BANK' | 'MOBILE_MONEY' | 'CASH' | 'CHEQUE';
export type MomoNetwork = 'MTN' | 'TELECEL' | 'AIRTELTIGO';

export interface PayoutDetails {
  readonly method: PayoutMethod;
  readonly bankName?: string | undefined;
  readonly accountName?: string | undefined;
  readonly accountNumber?: string | undefined;
  readonly bankBranch?: string | undefined;
  readonly momoNetwork?: MomoNetwork | undefined;
  readonly momoNumber?: string | undefined;
}

export interface PayoutRule {
  readonly field: string;
  readonly rule: 'REQUIRED' | 'NOT_FOR_METHOD' | 'ACCOUNT_NUMBER_INVALID' | 'MOMO_NUMBER_INVALID';
}

type Field = Exclude<keyof PayoutDetails, 'method'>;
const FIELDS: readonly Field[] = ['bankName', 'accountName', 'accountNumber', 'bankBranch', 'momoNetwork', 'momoNumber'];

/** What each method needs, and what else it may carry. */
const SHAPE: Readonly<Record<PayoutMethod, { readonly required: readonly Field[]; readonly optional: readonly Field[] }>> = {
  BANK: { required: ['bankName', 'accountName', 'accountNumber'], optional: ['bankBranch'] },
  MOBILE_MONEY: { required: ['momoNetwork', 'momoNumber'], optional: [] },
  CASH: { required: [], optional: [] },
  CHEQUE: { required: [], optional: [] },
};

/** A Ghanaian bank account number: digits only, 6 to 20 of them. */
const ACCOUNT_NUMBER = /^[0-9]{6,20}$/;
/** A Ghanaian mobile money wallet: +233 and nine digits. */
const GHANA_MOBILE = /^\+233[0-9]{9}$/;
/** How many trailing characters of an account or wallet the masked form shows (FR-PUR-001). */
export const VISIBLE_CHARACTERS = 4;

/** The details trimmed and checked against their method: required fields present, no field of another method. */
export function judgePayoutDetails(input: PayoutDetails): Result<PayoutDetails, PayoutRule[]> {
  const shape = SHAPE[input.method];
  const broken: PayoutRule[] = [];
  const out: Record<string, string> = {};
  for (const field of FIELDS) {
    const value = input[field]?.trim();
    const allowed = shape.required.includes(field) || shape.optional.includes(field);
    if (value === undefined || value === '') {
      if (shape.required.includes(field)) broken.push({ field: `/payoutDetails/${field}`, rule: 'REQUIRED' });
    } else if (!allowed) {
      broken.push({ field: `/payoutDetails/${field}`, rule: 'NOT_FOR_METHOD' });
    } else if (field === 'accountNumber' && !ACCOUNT_NUMBER.test(value)) {
      broken.push({ field: `/payoutDetails/${field}`, rule: 'ACCOUNT_NUMBER_INVALID' });
    } else if (field === 'momoNumber' && !GHANA_MOBILE.test(value)) {
      broken.push({ field: `/payoutDetails/${field}`, rule: 'MOMO_NUMBER_INVALID' });
    } else {
      out[field] = value;
    }
  }
  return broken.length > 0 ? err(broken) : ok({ method: input.method, ...out } as PayoutDetails);
}

const tail = (value: string) => `****${value.slice(-VISIBLE_CHARACTERS)}`;

/** The only form payout details are shown in: the bank or network, the account name, the last four characters. */
export function maskPayout(details: PayoutDetails): string {
  switch (details.method) {
    case 'BANK':
      return `${details.bankName}, ${details.accountName}, ${tail(details.accountNumber!)}`;
    case 'MOBILE_MONEY':
      return `${details.momoNetwork} MoMo, ${tail(details.momoNumber!)}`;
    case 'CASH':
      return 'Cash';
    case 'CHEQUE':
      return 'Cheque to the registered name';
  }
}

export type PayeeRefusal = 'PAYOUT_DETAILS_MISSING' | 'PAYOUT_METHOD_DIFFERS';

/**
 * Which payout details a payment pays to (FR-PUR-002): a bank transfer or a wallet payment goes only to the approved
 * details of that method in force when the payment is prepared; cash and cheques need none. A change waiting for
 * approval is never used.
 */
export function judgePayee(method: PayoutMethod, inForce: { readonly id: string; readonly method: PayoutMethod } | null): Result<string | null, PayeeRefusal> {
  if (method === 'CASH' || method === 'CHEQUE') return ok(null);
  if (inForce === null) return err('PAYOUT_DETAILS_MISSING');
  return inForce.method === method ? ok(inForce.id) : err('PAYOUT_METHOD_DIFFERS');
}
