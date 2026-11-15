import { err, ok, type Result } from '@hakorem/kernel';
import type { CatalogueRule } from './catalogue';

/** Ghana's sixteen regions (FR-MDM-008: an address names one). */
export const GHANA_REGIONS = [
  'Ahafo',
  'Ashanti',
  'Bono',
  'Bono East',
  'Central',
  'Eastern',
  'Greater Accra',
  'North East',
  'Northern',
  'Oti',
  'Savannah',
  'Upper East',
  'Upper West',
  'Volta',
  'Western',
  'Western North',
] as const;

/** Ghana's country code. A national significant number is nine digits starting 2, 3 or 5 (mobile 2x and 5x, fixed 3x). */
const GHANA = '233';
const GHANA_NATIONAL = /^[235][0-9]{8}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const SEPARATORS = /[\s-]/g;
/** GhanaPostGPS: two letters for the district, then three or four digits and four digits. */
const DIGITAL_ADDRESS = /^[A-Z]{2}-[0-9]{3,4}-[0-9]{4}$/;

/**
 * A phone number as it is stored (FR-MDM-008): E.164. A Ghanaian number typed the local way, `0244123456`, or with
 * the country code and no plus, `233244123456`, becomes `+233244123456`; spaces and hyphens are ignored. A number
 * with any other country code is kept as typed, if it is E.164.
 */
export function normaliseGhanaPhone(input: string): Result<string, 'INVALID_PHONE'> {
  const compact = input.replace(SEPARATORS, '');
  let national: string | null = null;
  if (compact.startsWith(`+${GHANA}`)) national = compact.slice(GHANA.length + 1);
  else if (compact.startsWith('+')) return E164.test(compact) ? ok(compact) : err('INVALID_PHONE');
  else if (compact.startsWith(GHANA)) national = compact.slice(GHANA.length);
  else if (compact.startsWith('0')) national = compact.slice(1);
  return national !== null && GHANA_NATIONAL.test(national) ? ok(`+${GHANA}${national}`) : err('INVALID_PHONE');
}

export interface AddressInput {
  readonly region: string;
  readonly line1: string;
  readonly digitalAddress: string | undefined;
  readonly recipientPhone: string;
}

export interface AddressFacts {
  readonly region: (typeof GHANA_REGIONS)[number];
  readonly recipientPhone: string;
  readonly digitalAddress: string | null;
}

/**
 * A delivery address in Ghana format (FR-MDM-008): one of the sixteen regions, a landmark (`line1`) or a
 * GhanaPostGPS digital address, and a driver contact number, normalised like any phone.
 */
export function planAddress(input: AddressInput): Result<AddressFacts, CatalogueRule[]> {
  const rules: CatalogueRule[] = [];
  const region = GHANA_REGIONS.find((name) => name.toLowerCase() === input.region.trim().toLowerCase());
  if (region === undefined) rules.push({ field: '/region', rule: 'UNKNOWN_REGION' });
  const digital = input.digitalAddress === undefined ? null : input.digitalAddress.trim().toUpperCase();
  if (digital !== null && !DIGITAL_ADDRESS.test(digital)) rules.push({ field: '/digitalAddress', rule: 'INVALID_DIGITAL_ADDRESS' });
  if (input.line1.trim().length === 0 && digital === null) rules.push({ field: '/line1', rule: 'LANDMARK_OR_DIGITAL_ADDRESS' });
  const phone = normaliseGhanaPhone(input.recipientPhone);
  if (!phone.ok) rules.push({ field: '/recipientPhone', rule: phone.error });
  if (rules.length > 0 || region === undefined || !phone.ok) return err(rules);
  return ok({ region, recipientPhone: phone.value, digitalAddress: digital });
}

export interface AssignmentWindow {
  readonly id: string;
  readonly validFrom: Date;
  readonly validTo: Date | null;
}

export interface AssignmentPlan {
  /** Live assignments that started earlier and are ended where the new one starts. */
  readonly end: ReadonlyArray<{ readonly id: string; readonly validTo: Date }>;
  /** Live assignments that start inside the new window and are archived as replaced. */
  readonly replace: readonly string[];
}

/**
 * Assigning a price list to a customer (FR-MDM-021): a customer has at most one assigned list at a time, so the new
 * window `[from, to)` replaces what it meets. An assignment that started earlier ends where the new one starts; one
 * that starts inside the new window is archived. The exclusion constraint on `mdm.customer_price_list` is the
 * backstop.
 */
export function planPriceListAssignment(live: readonly AssignmentWindow[], from: Date, to: Date | null): Result<AssignmentPlan, CatalogueRule[]> {
  if (to !== null && to.getTime() <= from.getTime()) return err([{ field: '/validTo', rule: 'NOT_AFTER_VALID_FROM' }]);
  const end: Array<{ id: string; validTo: Date }> = [];
  const replace: string[] = [];
  for (const window of live) {
    const endsAfterStart = window.validTo === null || window.validTo.getTime() > from.getTime();
    const startsBeforeEnd = to === null || window.validFrom.getTime() < to.getTime();
    if (!endsAfterStart || !startsBeforeEnd) continue;
    if (window.validFrom.getTime() < from.getTime()) end.push({ id: window.id, validTo: from });
    else replace.push(window.id);
  }
  return ok({ end, replace });
}
