/**
 * The business buyer named on a counter receipt without a customer account (the owner's addition (2) to A-200, A-285
 * (c)): the name and the tax identification number printed on the receipt, so the buyer can reclaim the input tax
 * (docs/security/COMPLIANCE.md section 5: a receipt without the purchaser's name and TIN does not qualify). The TIN is
 * Restricted (DC-25, E-1): printed on the document, never logged, and audited only masked.
 */

/** A GRA TIN: one letter for the kind of taxpayer (P, C, G, Q, V) and ten digits. */
const GRA_TIN = /^[PCGQV][0-9]{10}$/;
/** An individual's TIN is their Ghana Card PIN: GHA, nine digits and a check digit. */
const GHANA_CARD_PIN = /^GHA-[0-9]{9}-[0-9]$/;
/** The printed name, as `ck_billing_document_customer_name` holds it. */
const NAME_MAX = 160;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** The characters of a TIN left visible where one is shown masked, as MDM masks a customer's. */
const TIN_VISIBLE = 4;

export interface BuyerDetails {
  readonly name: string;
  readonly tin: string;
}

export type BuyerRule = { readonly field: 'name'; readonly rule: 'BUYER_NAME_INVALID' } | { readonly field: 'tin'; readonly rule: 'BUYER_TIN_INVALID' };

export type BuyerVerdict = { readonly ok: true; readonly value: BuyerDetails } | { readonly ok: false; readonly rules: readonly BuyerRule[] };

/** Whether a TIN, as stored, is of a form Ghana issues. */
export function isGhanaTin(tin: string): boolean {
  return GRA_TIN.test(tin) || GHANA_CARD_PIN.test(tin);
}

/** The buyer's details as printed: the name trimmed, the TIN trimmed and upper-cased; each refused in a form it may not be printed in. */
export function buyerVerdict(buyer: { readonly name: string; readonly tin: string }): BuyerVerdict {
  const name = buyer.name.trim();
  const tin = buyer.tin.trim().toUpperCase();
  const rules: BuyerRule[] = [];
  if (name.length === 0 || name.length > NAME_MAX || CONTROL.test(name)) rules.push({ field: 'name', rule: 'BUYER_NAME_INVALID' });
  if (!isGhanaTin(tin)) rules.push({ field: 'tin', rule: 'BUYER_TIN_INVALID' });
  return rules.length === 0 ? { ok: true, value: { name, tin } } : { ok: false, rules };
}

/** A TIN as an audit row or a log may show it: only its last four characters. */
export function maskTin(tin: string | null): string | null {
  if (tin === null) return null;
  return `${'*'.repeat(Math.max(tin.length - TIN_VISIBLE, 0))}${tin.slice(-TIN_VISIBLE)}`;
}
