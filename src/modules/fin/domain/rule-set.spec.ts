import { describe, expect, it } from 'vitest';
import { postingCatalogueGaps, type CatalogueFacts } from './rule-set';

const complete: CatalogueFacts = {
  declared: ['inv.GoodsReceived', 'pur.SupplierPaymentMade'],
  handled: ['inv.GoodsReceived', 'pur.SupplierPaymentMade'],
  eventTypes: [
    { code: 'inv.GoodsReceived', amountKeys: ['value'] },
    { code: 'pur.SupplierPaymentMade', amountKeys: ['amount'] },
  ],
  rules: [
    { eventCode: 'inv.GoodsReceived', amountKey: 'value', side: 'D' },
    { eventCode: 'inv.GoodsReceived', amountKey: 'value', side: 'C' },
    { eventCode: 'pur.SupplierPaymentMade', amountKey: 'amount', side: 'D' },
    { eventCode: 'pur.SupplierPaymentMade', amountKey: 'amount', side: 'C' },
  ],
};

describe('the boot assertion: every posting event has a handler and a complete rule set (ADR-0003, FR-FIN-005)', () => {
  it('finds nothing missing in a complete catalogue', () => {
    expect(postingCatalogueGaps(complete)).toEqual([]);
  });

  it('names an event a module declares as posting that the ledger does not catalogue', () => {
    expect(postingCatalogueGaps({ ...complete, declared: [...complete.declared, 'inv.StockWrittenOff'] })).toEqual([
      'inv.StockWrittenOff is declared as posting to the ledger but is not in fin.posting_event_type',
    ]);
  });

  it('names a catalogued event with no handler', () => {
    expect(postingCatalogueGaps({ ...complete, handled: ['inv.GoodsReceived'] })).toEqual(['pur.SupplierPaymentMade has no posting handler']);
  });

  it('names an amount with no rule in force', () => {
    expect(postingCatalogueGaps({ ...complete, rules: complete.rules.filter((r) => r.eventCode !== 'pur.SupplierPaymentMade') })).toEqual([
      'pur.SupplierPaymentMade: amount "amount" has no posting rule in force',
      'pur.SupplierPaymentMade: its rules in force have no debit side',
      'pur.SupplierPaymentMade: its rules in force have no credit side',
    ]);
  });

  it('names an event whose rules post only one side', () => {
    expect(postingCatalogueGaps({ ...complete, rules: complete.rules.filter((r) => !(r.eventCode === 'inv.GoodsReceived' && r.side === 'C')) })).toEqual([
      'inv.GoodsReceived: its rules in force have no credit side',
    ]);
    expect(postingCatalogueGaps({ ...complete, rules: complete.rules.filter((r) => !(r.eventCode === 'inv.GoodsReceived' && r.side === 'D')) })).toEqual([
      'inv.GoodsReceived: its rules in force have no debit side',
    ]);
  });

  it('names a rule for an amount the event does not carry', () => {
    expect(postingCatalogueGaps({ ...complete, rules: [...complete.rules, { eventCode: 'inv.GoodsReceived', amountKey: 'gross', side: 'C' }] })).toEqual([
      'inv.GoodsReceived: a rule names amount "gross", which the event does not carry',
    ]);
  });

  it('asks no rules of an event that carries no amounts: it posts only as the mirror of an earlier entry (ADR-0064)', () => {
    const mirror: CatalogueFacts = { ...complete, declared: [...complete.declared, 'pay.PaymentReversed'], handled: [...complete.handled, 'pay.PaymentReversed'], eventTypes: [...complete.eventTypes, { code: 'pay.PaymentReversed', amountKeys: [] }] };
    expect(postingCatalogueGaps(mirror)).toEqual([]);
    expect(postingCatalogueGaps({ ...mirror, rules: [...complete.rules, { eventCode: 'pay.PaymentReversed', amountKey: 'tender', side: 'D' }] })).toEqual([
      'pay.PaymentReversed: a rule names amount "tender", which the event does not carry',
    ]);
  });
});
