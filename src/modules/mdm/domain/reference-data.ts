import { err, ok, type Result } from '@hakorem/kernel';
import type { CatalogueRule } from './catalogue';

export type PaymentMethodKind = 'CASH' | 'MOBILE_MONEY' | 'CARD' | 'BANK_TRANSFER' | 'CHEQUE' | 'STORE_CREDIT';

/** Mobile money and card are cleared only by a verified provider callback or lookup (FR-MDM-009); the flag never goes off. */
const ALWAYS_VERIFIED: ReadonlySet<PaymentMethodKind> = new Set(['MOBILE_MONEY', 'CARD']);

export interface PaymentMethodFlags {
  readonly kind: PaymentMethodKind;
  readonly requiresProviderVerification: boolean;
  readonly allowedOffline: boolean;
}

export interface PaymentMethodChange {
  readonly requiresProviderVerification?: boolean | undefined;
  readonly allowedOffline?: boolean | undefined;
  readonly channels?: readonly string[] | undefined;
}

/**
 * A change to a payment method (FR-MDM-009, ADR-0027). Verification stays on for mobile money and card. Only cash may
 * be taken at an offline counter, and mobile money too when the setting `pos.offline_mobile_money_allowed` is on
 * (A-041); a card or a transfer can never be confirmed offline. A method keeps at least one channel.
 */
export function planPaymentMethodChange(
  current: PaymentMethodFlags,
  change: PaymentMethodChange,
  policy: { readonly offlineMobileMoneyAllowed: boolean },
): Result<{ readonly requiresProviderVerification: boolean; readonly allowedOffline: boolean }, CatalogueRule[]> {
  const requiresProviderVerification = change.requiresProviderVerification ?? current.requiresProviderVerification;
  const allowedOffline = change.allowedOffline ?? current.allowedOffline;
  const rules: CatalogueRule[] = [];
  if (!requiresProviderVerification && ALWAYS_VERIFIED.has(current.kind)) rules.push({ field: '/requiresProviderVerification', rule: 'VERIFICATION_REQUIRED' });
  const offlineKind = current.kind === 'CASH' || (current.kind === 'MOBILE_MONEY' && policy.offlineMobileMoneyAllowed);
  if (change.allowedOffline === true && !offlineKind) rules.push({ field: '/allowedOffline', rule: 'OFFLINE_NOT_ALLOWED' });
  if (change.channels !== undefined && change.channels.length === 0) rules.push({ field: '/channels', rule: 'NO_CHANNELS' });
  return rules.length > 0 ? err(rules) : ok({ requiresProviderVerification, allowedOffline });
}

/** An area as it is compared: case, outer spaces and repeated inner spaces ignored. */
function areaKey(area: string): string {
  return tidy(area).toLowerCase();
}

function tidy(area: string): string {
  return area.trim().replace(/\s+/g, ' ');
}

/** Whether two area names are the same place for matching. */
export function sameArea(a: string, b: string): boolean {
  return areaKey(a) === areaKey(b);
}

/** A zone's areas as stored: tidied, at least one, none blank or named twice (FR-MDM-010). */
export function defineZoneAreas(areas: readonly string[]): Result<string[], CatalogueRule[]> {
  if (areas.length === 0) return err([{ field: '/areas', rule: 'NO_AREAS' }]);
  const rules: CatalogueRule[] = [];
  const seen = new Set<string>();
  areas.forEach((area, index) => {
    const key = areaKey(area);
    if (key === '') rules.push({ field: `/areas/${index}`, rule: 'AREA_BLANK' });
    else if (seen.has(key)) rules.push({ field: `/areas/${index}`, rule: 'AREA_REPEATED' });
    seen.add(key);
  });
  return rules.length > 0 ? err(rules) : ok(areas.map(tidy));
}

/** Each area another live, active zone already covers: an address must map to one zone or none (A-116). */
export function areaConflicts(areas: readonly string[], others: ReadonlyArray<{ readonly code: string; readonly areas: readonly string[] }>): CatalogueRule[] {
  const rules: CatalogueRule[] = [];
  areas.forEach((area, index) => {
    const owner = others.find((zone) => zone.areas.some((covered) => sameArea(covered, area)));
    if (owner !== undefined) rules.push({ field: `/areas/${index}`, rule: `AREA_IN_ZONE:${owner.code}` });
  });
  return rules;
}

export interface ZoneForMatch {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly areas: readonly string[];
  readonly feePesewas: bigint;
  readonly freeOverPesewas: bigint | null;
  readonly cutoffTime: string;
}

/** The zone that delivers to an address: one whose areas name the address's area, else its city, else none. */
export function matchDeliveryZone<Z extends ZoneForMatch>(address: { readonly area: string; readonly city: string }, zones: readonly Z[]): Z | null {
  const covering = (place: string) => zones.find((zone) => zone.areas.some((area) => sameArea(area, place)));
  return covering(address.area) ?? covering(address.city) ?? null;
}

export interface DeliveryQuoteFacts {
  readonly deliverable: boolean;
  readonly zone: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly feePesewas: bigint | null;
  readonly freeOverPesewas: bigint | null;
  readonly cutoffTime: string | null;
}

/** The quote for a matched zone: its exact fee (zero is a fee), or "delivery unavailable" with no fee, never zero. */
export function quoteForZone(zone: ZoneForMatch | null): DeliveryQuoteFacts {
  if (zone === null) return { deliverable: false, zone: null, feePesewas: null, freeOverPesewas: null, cutoffTime: null };
  return { deliverable: true, zone: { id: zone.id, code: zone.code, name: zone.name }, feePesewas: zone.feePesewas, freeOverPesewas: zone.freeOverPesewas, cutoffTime: zone.cutoffTime };
}
