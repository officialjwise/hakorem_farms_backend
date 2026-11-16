import type { Side } from './posting';

/** What the boot assertion compares (ADR-0003 safeguard one). */
export interface CatalogueFacts {
  /** Event types the publishing modules declare as posting to the ledger (◆ in docs/DOMAIN_MODEL.md section 5). */
  readonly declared: readonly string[];
  /** Event types FIN has a posting handler for. */
  readonly handled: readonly string[];
  /** `fin.posting_event_type`. */
  readonly eventTypes: readonly { readonly code: string; readonly amountKeys: readonly string[] }[];
  /** The posting rules in force today. */
  readonly rules: readonly { readonly eventCode: string; readonly amountKey: string; readonly side: Side }[];
}

/**
 * Every gap that must stop the application booting: a declared event the ledger does not catalogue, a catalogued event
 * with no handler, an amount with no rule in force, an event whose rules post only one side, a rule for an amount the
 * event does not carry. An empty list is a pass.
 */
export function postingCatalogueGaps(facts: CatalogueFacts): string[] {
  const gaps: string[] = [];
  const catalogued = new Set(facts.eventTypes.map((t) => t.code));
  for (const code of facts.declared) {
    if (!catalogued.has(code)) {
      gaps.push(`${code} is declared as posting to the ledger but is not in fin.posting_event_type`);
    }
  }
  for (const type of facts.eventTypes) {
    if (!facts.handled.includes(type.code)) {
      gaps.push(`${type.code} has no posting handler`);
    }
    const rules = facts.rules.filter((r) => r.eventCode === type.code);
    for (const key of type.amountKeys) {
      if (!rules.some((r) => r.amountKey === key)) {
        gaps.push(`${type.code}: amount "${key}" has no posting rule in force`);
      }
    }
    if (!rules.some((r) => r.side === 'D')) {
      gaps.push(`${type.code}: its rules in force have no debit side`);
    }
    if (!rules.some((r) => r.side === 'C')) {
      gaps.push(`${type.code}: its rules in force have no credit side`);
    }
    for (const rule of rules) {
      if (!type.amountKeys.includes(rule.amountKey)) {
        gaps.push(`${type.code}: a rule names amount "${rule.amountKey}", which the event does not carry`);
      }
    }
  }
  return gaps;
}
