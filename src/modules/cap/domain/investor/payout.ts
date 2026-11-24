/**
 * An investor's payout details and identity number (FR-CAP-002, ADR-0022). Restricted data: the application seals the
 * judged details with the investor's own key and keeps only the masked form in clear. Pure.
 */
export type MomoNetwork = 'MTN' | 'TELECEL' | 'AIRTELTIGO';

export interface InvestorPayout {
  readonly method: 'BANK' | 'MOBILE_MONEY';
  readonly bankName?: string | undefined;
  readonly accountName?: string | undefined;
  readonly accountNumber?: string | undefined;
  readonly momoNetwork?: MomoNetwork | undefined;
  readonly momoNumber?: string | undefined;
}

export interface PayoutRule {
  readonly field: string;
  readonly rule: 'REQUIRED' | 'NOT_FOR_METHOD' | 'ACCOUNT_NUMBER_INVALID' | 'MOMO_NUMBER_INVALID' | 'ID_NUMBER_INVALID';
}

type Field = Exclude<keyof InvestorPayout, 'method'>;
const FIELDS: readonly Field[] = ['bankName', 'accountName', 'accountNumber', 'momoNetwork', 'momoNumber'];
const REQUIRED: Readonly<Record<InvestorPayout['method'], readonly Field[]>> = {
  BANK: ['bankName', 'accountName', 'accountNumber'],
  MOBILE_MONEY: ['momoNetwork', 'momoNumber'],
};
const ACCOUNT_NUMBER = /^[0-9]{6,20}$/;
const GHANA_MOBILE = /^\+233[0-9]{9}$/;
/** A Ghana Card (GHA-123456789-0) or another identity document's number: letters, digits and dashes. */
const ID_NUMBER = /^[A-Z0-9][A-Z0-9-]{4,38}[A-Z0-9]$/;
const VISIBLE = 4;

export type Judged<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly rules: PayoutRule[] };

/** The details trimmed and checked against their method: what it needs present, nothing of the other method. */
export function judgePayout(input: InvestorPayout): Judged<InvestorPayout> {
  const broken: PayoutRule[] = [];
  const out: Record<string, string> = {};
  for (const field of FIELDS) {
    const value = input[field]?.trim();
    const required = REQUIRED[input.method].includes(field);
    if (value === undefined || value === '') {
      if (required) broken.push({ field: `/payout/${field}`, rule: 'REQUIRED' });
    } else if (!required) {
      broken.push({ field: `/payout/${field}`, rule: 'NOT_FOR_METHOD' });
    } else if (field === 'accountNumber' && !ACCOUNT_NUMBER.test(value)) {
      broken.push({ field: `/payout/${field}`, rule: 'ACCOUNT_NUMBER_INVALID' });
    } else if (field === 'momoNumber' && !GHANA_MOBILE.test(value)) {
      broken.push({ field: `/payout/${field}`, rule: 'MOMO_NUMBER_INVALID' });
    } else {
      out[field] = value;
    }
  }
  return broken.length > 0 ? { ok: false, rules: broken } : { ok: true, value: { method: input.method, ...out } as InvestorPayout };
}

/** The last four digits of the account or wallet, the only part of it ever shown. */
export function payoutLast4(details: InvestorPayout): string {
  return (details.method === 'BANK' ? details.accountNumber! : details.momoNumber!).slice(-VISIBLE);
}

/** The only form payout details are shown in: the bank or network and the last four digits. */
export function maskPayout(details: InvestorPayout): string {
  return details.method === 'BANK' ? `${details.bankName}, ****${payoutLast4(details)}` : `${details.momoNetwork} MoMo, ****${payoutLast4(details)}`;
}

/** An identity number upper-cased and checked; its masked form shows only the last four characters. */
export function judgeIdNumber(input: string): Judged<{ readonly value: string; readonly masked: string }> {
  const value = input.trim().toUpperCase();
  if (!ID_NUMBER.test(value)) return { ok: false, rules: [{ field: '/idNumber', rule: 'ID_NUMBER_INVALID' }] };
  return { ok: true, value: { value, masked: `****${value.slice(-VISIBLE)}` } };
}
