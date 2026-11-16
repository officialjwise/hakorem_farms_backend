import { describe, expect, it } from 'vitest';
import { checkDeterminationChange, checkRuleChange, effectiveFrom, type ChangeFacts, type DatedDetermination, type DatedRule, type RuleProposal } from './rule-change';

const account = (id: string, code: string, subledgerKind: 'SUPPLIER' | 'TAX_LEVY' | 'BANK_ACCOUNT' | null = null, postable = true) => [id, { id, code, postable, subledgerKind }] as const;
const accounts = new Map([
  account('a-2000', '2000', 'SUPPLIER'),
  account('a-2010', '2010'),
  account('a-2020', '2020'),
  account('a-2100', '2100', 'TAX_LEVY'),
  account('a-2110', '2110', 'TAX_LEVY'),
  account('a-4100', '4100'),
  account('a-4110', '4110'),
  account('a-1100', '1100', 'BANK_ACCOUNT'),
  account('a-6999', '6999', null, false),
]);
const rule = (over: Partial<DatedRule>): DatedRule => ({
  id: 'r-1',
  eventCode: 'prc.DirectCostIncurred',
  amountKey: 'value',
  side: 'C',
  accountId: 'a-2020',
  determinantType: null,
  determinantRole: null,
  validFrom: '2020-01-01',
  validTo: null,
  ...over,
});
const determination = (over: Partial<DatedDetermination>): DatedDetermination => ({
  id: 'd-1',
  type: 'TAX_LEVY',
  key: '*',
  role: 'OUTPUT',
  accountId: 'a-2100',
  validFrom: '2020-01-01',
  validTo: null,
  ...over,
});
const facts = (over: Partial<ChangeFacts> = {}): ChangeFacts => ({
  today: '2026-11-16',
  eventTypes: new Map([
    ['prc.DirectCostIncurred', ['value']],
    ['fin.ManualJournalApproved', ['debit', 'credit']],
  ]),
  rules: [rule({}), rule({ id: 'r-2', side: 'D', accountId: 'a-2010' }), rule({ id: 'r-mj', eventCode: 'fin.ManualJournalApproved', amountKey: 'debit', side: 'D', accountId: null, determinantType: 'ENTERED', determinantRole: 'AS_ENTERED' })],
  determinations: [determination({}), determination({ id: 'd-2', type: 'PAYMENT_METHOD_KIND', key: 'BANK', role: 'PAYOUT', accountId: 'a-1100' })],
  accounts,
  ...over,
});
const proposal = (over: Partial<RuleProposal> = {}): RuleProposal => ({
  eventCode: 'prc.DirectCostIncurred',
  amountKey: 'value',
  side: 'C',
  accountId: 'a-2010',
  determinantType: null,
  determinantRole: null,
  validFrom: '2026-12-01',
  ...over,
});

describe('a posting rule change replaces one rule from a date (FR-FIN-005, A-191)', () => {
  it('accepts a fixed account replacing the rule in force, from a date not before today', () => {
    expect(checkRuleChange(proposal(), facts())).toEqual({ ok: true, value: { replaces: 'r-1' } });
    expect(checkRuleChange(proposal({ validFrom: '2026-11-16' }), facts())).toEqual({ ok: true, value: { replaces: 'r-1' } });
  });

  it('accepts a determinant that has determinations in force', () => {
    expect(checkRuleChange(proposal({ accountId: null, determinantType: 'TAX_LEVY', determinantRole: 'OUTPUT', side: 'C', amountKey: 'value' }), facts({ accounts }))).toEqual({
      ok: false,
      error: [{ field: '/accountId', rule: 'SUBLEDGER_DIFFERS' }],
    });
    const plain = facts({ determinations: [determination({ accountId: 'a-4100' }), determination({ id: 'd-3', key: 'NHIL', accountId: 'a-4110' })] });
    expect(checkRuleChange(proposal({ accountId: null, determinantType: 'TAX_LEVY', determinantRole: 'OUTPUT' }), plain)).toEqual({ ok: true, value: { replaces: 'r-1' } });
  });

  it('refuses an unknown event or amount, and the rules of a journal posted as entered', () => {
    expect(checkRuleChange(proposal({ eventCode: 'bil.InvoiceIssued' }), facts())).toEqual({ ok: false, error: [{ field: '/eventCode', rule: 'UNKNOWN_EVENT' }] });
    expect(checkRuleChange(proposal({ amountKey: 'gross' }), facts())).toEqual({ ok: false, error: [{ field: '/amountKey', rule: 'UNKNOWN_AMOUNT' }] });
    expect(checkRuleChange(proposal({ eventCode: 'fin.ManualJournalApproved', amountKey: 'debit', side: 'D' }), facts())).toEqual({ ok: false, error: [{ field: '/eventCode', rule: 'POSTS_AS_ENTERED' }] });
  });

  it('refuses a target that is not exactly one account or one determinant with its role, and the entered determinant', () => {
    const bad = [{ field: '/accountId', rule: 'TARGET_INVALID' }];
    expect(checkRuleChange(proposal({ accountId: null }), facts())).toEqual({ ok: false, error: bad });
    expect(checkRuleChange(proposal({ determinantType: 'TAX_LEVY', determinantRole: 'OUTPUT' }), facts())).toEqual({ ok: false, error: bad });
    expect(checkRuleChange(proposal({ accountId: null, determinantType: 'TAX_LEVY' }), facts())).toEqual({ ok: false, error: bad });
    expect(checkRuleChange(proposal({ accountId: null, determinantType: 'ENTERED', determinantRole: 'AS_ENTERED' }), facts())).toEqual({ ok: false, error: bad });
  });

  it('refuses a date in the past, a rule with nothing to replace, and a rule already scheduled after it', () => {
    expect(checkRuleChange(proposal({ validFrom: '2026-11-15' }), facts())).toEqual({ ok: false, error: [{ field: '/validFrom', rule: 'VALID_FROM_PAST' }] });
    expect(checkRuleChange(proposal({ side: 'D', accountId: 'a-2020' }), facts({ rules: [rule({})] }))).toEqual({ ok: false, error: [{ field: '/side', rule: 'NOTHING_TO_REPLACE' }] });
    const ended = facts({ rules: [rule({ validTo: '2026-12-01' })] });
    expect(checkRuleChange(proposal(), ended)).toEqual({ ok: false, error: [{ field: '/side', rule: 'NOTHING_TO_REPLACE' }] });
    const scheduled = facts({ rules: [rule({ validTo: '2027-01-01' }), rule({ id: 'r-3', accountId: 'a-2010', validFrom: '2027-01-01' })] });
    expect(checkRuleChange(proposal(), scheduled)).toEqual({ ok: false, error: [{ field: '/validFrom', rule: 'LATER_RULE_EXISTS' }] });
    const startsThatDay = facts({ rules: [rule({ validFrom: '2026-12-01' })] });
    expect(checkRuleChange(proposal(), startsThatDay)).toEqual({ ok: false, error: [{ field: '/validFrom', rule: 'LATER_RULE_EXISTS' }] });
  });

  it('refuses an unknown or non-postable account, a determinant with nothing in force, a changed subledger and no change', () => {
    expect(checkRuleChange(proposal({ accountId: 'a-nope' }), facts())).toEqual({ ok: false, error: [{ field: '/accountId', rule: 'UNKNOWN_ACCOUNT' }] });
    expect(checkRuleChange(proposal({ accountId: 'a-6999' }), facts())).toEqual({ ok: false, error: [{ field: '/accountId', rule: 'ACCOUNT_NOT_POSTABLE' }] });
    expect(checkRuleChange(proposal({ accountId: null, determinantType: 'GL_GROUP', determinantRole: 'INVENTORY' }), facts())).toEqual({ ok: false, error: [{ field: '/determinantType', rule: 'NO_DETERMINATION' }] });
    expect(checkRuleChange(proposal({ accountId: 'a-2000' }), facts())).toEqual({ ok: false, error: [{ field: '/accountId', rule: 'SUBLEDGER_DIFFERS' }] });
    expect(checkRuleChange(proposal({ accountId: 'a-2020' }), facts())).toEqual({ ok: false, error: [{ field: '/accountId', rule: 'UNCHANGED' }] });
    const determined = facts({ rules: [rule({ accountId: null, determinantType: 'TAX_LEVY', determinantRole: 'OUTPUT' })], determinations: [determination({ accountId: 'a-4100' })] });
    expect(checkRuleChange(proposal({ accountId: null, determinantType: 'TAX_LEVY', determinantRole: 'OUTPUT' }), determined)).toEqual({ ok: false, error: [{ field: '/accountId', rule: 'UNCHANGED' }] });
    expect(checkRuleChange(proposal({ accountId: 'a-4110' }), determined)).toEqual({ ok: true, value: { replaces: 'r-1' } });
  });
});

describe('an account determination change maps one key from a date (FR-FIN-005, ADR-0020, A-191)', () => {
  const nhil = { determinantType: 'TAX_LEVY' as const, determinantKey: 'NHIL', role: 'OUTPUT', accountId: 'a-2110', validFrom: '2027-01-01' };

  it('adds a row for a key with none of its own, posting to an account of the same subledger', () => {
    expect(checkDeterminationChange(nhil, facts())).toEqual({ ok: true, value: { replaces: null } });
  });

  it('replaces the key row in force', () => {
    expect(checkDeterminationChange({ ...nhil, determinantKey: '*' }, facts())).toEqual({ ok: true, value: { replaces: 'd-1' } });
  });

  it('refuses a past date, an unknown or non-postable account, a changed subledger, a later row and no change', () => {
    expect(checkDeterminationChange({ ...nhil, validFrom: '2026-01-01' }, facts())).toEqual({ ok: false, error: [{ field: '/validFrom', rule: 'VALID_FROM_PAST' }] });
    expect(checkDeterminationChange({ ...nhil, accountId: 'a-nope' }, facts())).toEqual({ ok: false, error: [{ field: '/accountId', rule: 'UNKNOWN_ACCOUNT' }] });
    expect(checkDeterminationChange({ ...nhil, accountId: 'a-6999' }, facts())).toEqual({ ok: false, error: [{ field: '/accountId', rule: 'ACCOUNT_NOT_POSTABLE' }] });
    expect(checkDeterminationChange({ ...nhil, accountId: 'a-4100' }, facts())).toEqual({ ok: false, error: [{ field: '/accountId', rule: 'SUBLEDGER_DIFFERS' }] });
    const later = facts({ determinations: [determination({}), determination({ id: 'd-9', key: 'NHIL', accountId: 'a-2110', validFrom: '2027-06-01' })] });
    expect(checkDeterminationChange(nhil, later)).toEqual({ ok: false, error: [{ field: '/validFrom', rule: 'LATER_RULE_EXISTS' }] });
    expect(checkDeterminationChange({ ...nhil, determinantKey: '*', accountId: 'a-2100' }, facts())).toEqual({ ok: false, error: [{ field: '/accountId', rule: 'UNCHANGED' }] });
  });

  it('allows any account for a role with no row in force yet', () => {
    expect(checkDeterminationChange({ determinantType: 'ASSET_CATEGORY', determinantKey: 'VEHICLE', role: 'INVENTORY', accountId: 'a-4100', validFrom: '2026-12-01' }, facts())).toEqual({ ok: true, value: { replaces: null } });
  });
});

describe('a change takes effect from its approval day, never earlier (A-191)', () => {
  it('is the later of the date asked for and the day it is approved', () => {
    expect(effectiveFrom('2026-12-01', '2026-11-20')).toBe('2026-12-01');
    expect(effectiveFrom('2026-11-16', '2026-11-20')).toBe('2026-11-20');
  });
});
