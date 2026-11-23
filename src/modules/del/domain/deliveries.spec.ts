import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { codVariance, dueAtDoor, judgePartDelivery, judgeProof, syncOutcomeOfProof, takesProof, type ProofFacts } from './deliveries';

const m = (pesewas: number) => Money.ofPesewas(BigInt(pesewas));
const proof = (overrides: Partial<ProofFacts> = {}): ProofFacts => ({
  due: m(2_240),
  collected: m(2_240),
  reason: null,
  note: null,
  signature: null,
  photo: { purpose: 'PROOF_OF_DELIVERY', ownedByDriver: true, quarantined: false },
  ...overrides,
});
const rules = (facts: ProofFacts) => judgeProof(facts).map((r) => `${r.field} ${r.rule}`);

describe('a proof of delivery and the cash collected on it (FR-DEL-008, FR-DEL-009)', () => {
  it('accepts a name and a photograph with the amount due collected exactly', () => {
    expect(rules(proof())).toEqual([]);
    expect(codVariance(m(2_240), m(2_240)).pesewas).toBe(0n);
  });

  it('refuses a proof with neither a signature nor a photograph (a name alone is not proof)', () => {
    expect(rules(proof({ photo: null }))).toEqual(['/photoFileId EVIDENCE_REQUIRED']);
  });

  it('accepts a signature alone', () => {
    expect(rules(proof({ photo: null, signature: { purpose: 'SIGNATURE', ownedByDriver: true, quarantined: false } }))).toEqual([]);
  });

  it("refuses a photograph uploaded for another use, by someone else, or held by the malware scan", () => {
    expect(rules(proof({ photo: { purpose: 'EVIDENCE', ownedByDriver: true, quarantined: false } }))).toEqual(['/photoFileId FILE_NOT_PROOF']);
    expect(rules(proof({ photo: { purpose: 'PROOF_OF_DELIVERY', ownedByDriver: false, quarantined: false } }))).toEqual(['/photoFileId FILE_NOT_YOURS']);
    expect(rules(proof({ photo: { purpose: 'PROOF_OF_DELIVERY', ownedByDriver: true, quarantined: true } }))).toEqual(['/photoFileId FILE_NOT_CLEAN']);
    expect(rules(proof({ photo: 'MISSING' }))).toEqual(['/photoFileId FILE_UNKNOWN']);
  });

  it('refuses a signature that is not a SIGNATURE file', () => {
    expect(rules(proof({ signature: { purpose: 'PROOF_OF_DELIVERY', ownedByDriver: true, quarantined: false } }))).toEqual(['/signatureFileId FILE_NOT_PROOF']);
  });

  it("flags FR-DEL-009's 240 short: 2,000 collected of 2,240 due needs a reason, and the variance is exactly 240", () => {
    expect(rules(proof({ collected: m(2_000) }))).toEqual(['/codVarianceReasonCode REASON_REQUIRED']);
    expect(rules(proof({ collected: m(2_000), reason: { domain: 'COD_VARIANCE', requiresNote: true }, note: 'Paid the rest by MoMo to the shop' }))).toEqual([]);
    expect(codVariance(m(2_240), m(2_000)).pesewas).toBe(240n);
  });

  it('refuses a short collection whose reason is of another domain, or needs a note it lacks', () => {
    expect(rules(proof({ collected: m(2_000), reason: { domain: 'REFUND', requiresNote: false } }))).toEqual(['/codVarianceReasonCode REASON_NOT_ALLOWED']);
    expect(rules(proof({ collected: m(2_000), reason: { domain: 'COD_VARIANCE', requiresNote: true } }))).toEqual(['/codVarianceNote NOTE_REQUIRED']);
    expect(rules(proof({ collected: m(2_000), reason: 'UNKNOWN' }))).toEqual(['/codVarianceReasonCode REASON_UNKNOWN']);
  });

  it('refuses a pesewa more than is due: a driver never collects above the amount fixed at dispatch', () => {
    expect(rules(proof({ collected: m(2_241) }))).toEqual(['/codCollectedPesewas ABOVE_DUE']);
  });

  it('refuses a reason or a note when the amount due was collected', () => {
    expect(rules(proof({ reason: { domain: 'COD_VARIANCE', requiresNote: false } }))).toEqual(['/codVarianceReasonCode REASON_NOT_NEEDED']);
    expect(rules(proof({ note: 'nothing to say' }))).toEqual(['/codVarianceNote REASON_NOT_NEEDED']);
  });

  it('takes nothing on an account delivery with nothing due, and a collection of nothing', () => {
    expect(rules(proof({ due: m(0), collected: m(0) }))).toEqual([]);
    expect(rules(proof({ due: m(0), collected: m(1) }))).toEqual(['/codCollectedPesewas ABOVE_DUE']);
  });

  it('takes a proof only on a delivery assigned or on its way', () => {
    expect(['SCHEDULED', 'ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED'].filter((s) => takesProof(s as never))).toEqual(['ASSIGNED', 'OUT_FOR_DELIVERY']);
  });
});

describe('a part delivery: what the customer kept, and what came back (CR-055, A-364 (b))', () => {
  const crates = { orderLineId: 'line-1', name: 'Big eggs, crate of 30', quantity: '12.000', uom: 'CRATE', weightKg: null };
  const pack = { orderLineId: 'line-2', name: 'Full chicken, 15 kg pack', quantity: '1.000', uom: 'PACK', weightKg: '14.650' };
  const reason = { domain: 'DELIVERY_FAILURE', requiresNote: false };

  it('takes everything delivered when no line is named, with no reason', () => {
    expect(judgePartDelivery([crates, pack], undefined, null)).toEqual({ broken: [], returned: [] });
    expect(judgePartDelivery([crates, pack], [{ orderLineId: 'line-1', deliveredQty: '12.000' }], null)).toEqual({ broken: [], returned: [] });
  });

  it('takes 10 of 12 crates kept, the rest back with a DELIVERY_FAILURE reason, and a weighed pack sent back whole', () => {
    expect(judgePartDelivery([crates, pack], [{ orderLineId: 'line-1', deliveredQty: '10.000' }, { orderLineId: 'line-2', deliveredQty: '0.000' }], reason)).toEqual({
      broken: [],
      returned: [
        { orderLineId: 'line-1', dispatchedQty: '12.000', deliveredQty: '10.000', returnedQty: '2.000', weighed: false },
        { orderLineId: 'line-2', dispatchedQty: '1.000', deliveredQty: '0.000', returnedQty: '1.000', weighed: true },
      ],
    });
  });

  it('refuses an unknown or repeated line, more than was dispatched, part of a weighed pack, nothing delivered at all, and a reason that does not fit', () => {
    expect(judgePartDelivery([crates], [{ orderLineId: 'other', deliveredQty: '1.000' }], null).broken).toEqual([{ field: '/lines/0/orderLineId', rule: 'LINE_UNKNOWN' }]);
    expect(judgePartDelivery([crates], [{ orderLineId: 'line-1', deliveredQty: '1.000' }, { orderLineId: 'line-1', deliveredQty: '1.000' }], reason).broken).toEqual([{ field: '/lines/1/orderLineId', rule: 'LINE_REPEATED' }]);
    expect(judgePartDelivery([crates], [{ orderLineId: 'line-1', deliveredQty: '12.001' }], null).broken).toEqual([{ field: '/lines/0/deliveredQty', rule: 'ABOVE_DISPATCHED' }]);
    expect(judgePartDelivery([pack], [{ orderLineId: 'line-2', deliveredQty: '0.500' }], reason).broken).toEqual([{ field: '/lines/0/deliveredQty', rule: 'WEIGHED_LINE_WHOLE' }]);
    expect(judgePartDelivery([crates, pack], [{ orderLineId: 'line-1', deliveredQty: '0.000' }, { orderLineId: 'line-2', deliveredQty: '0.000' }], reason).broken).toEqual([{ field: '/lines', rule: 'NOTHING_DELIVERED' }]);
    expect(judgePartDelivery([crates], [{ orderLineId: 'line-1', deliveredQty: '10.000' }], null).broken).toEqual([{ field: '/returnedReasonCode', rule: 'REASON_REQUIRED' }]);
    expect(judgePartDelivery([crates], [{ orderLineId: 'line-1', deliveredQty: '10.000' }], 'UNKNOWN').broken).toEqual([{ field: '/returnedReasonCode', rule: 'REASON_UNKNOWN' }]);
    expect(judgePartDelivery([crates], [{ orderLineId: 'line-1', deliveredQty: '10.000' }], { domain: 'COD_VARIANCE', requiresNote: false }).broken).toEqual([{ field: '/returnedReasonCode', rule: 'REASON_NOT_ALLOWED' }]);
    expect(judgePartDelivery([crates], [{ orderLineId: 'line-1', deliveredQty: '12.000' }], reason).broken).toEqual([{ field: '/returnedReasonCode', rule: 'REASON_NOT_NEEDED' }]);
    expect(judgePartDelivery([crates], undefined, null, 'Two crates cracked').broken).toEqual([{ field: '/returnedNote', rule: 'REASON_NOT_NEEDED' }]);
    const refused = { domain: 'DELIVERY_FAILURE', requiresNote: true };
    expect(judgePartDelivery([crates], [{ orderLineId: 'line-1', deliveredQty: '10.000' }], refused).broken).toEqual([{ field: '/returnedNote', rule: 'NOTE_REQUIRED' }]);
    expect(judgePartDelivery([crates], [{ orderLineId: 'line-1', deliveredQty: '10.000' }], refused, 'Two crates cracked on the road').broken).toEqual([]);
  });
});

describe('the cash due at the door after a part delivery (CR-055, ADR-0093)', () => {
  it('is the cash due less what came back, never below zero, to the pesewa', () => {
    expect(dueAtDoor(Money.ofPesewas(66_000n), Money.ofPesewas(11_000n)).pesewas).toBe(55_000n);
    expect(dueAtDoor(Money.ofPesewas(66_000n), Money.ofPesewas(0n)).pesewas).toBe(66_000n);
    expect(dueAtDoor(Money.ofPesewas(66_000n), Money.ofPesewas(66_000n)).pesewas).toBe(0n);
    expect(dueAtDoor(Money.ofPesewas(2_240n), Money.ofPesewas(5_500n)).pesewas).toBe(0n);
    expect(dueAtDoor(Money.ofPesewas(0n), Money.ofPesewas(5_500n)).pesewas).toBe(0n);
    expect(dueAtDoor(Money.ofPesewas(5_501n), Money.ofPesewas(5_500n)).pesewas).toBe(1n);
  });
});

describe("the driver's sync: what a recorded proof or failure answers, first and again (CR-057 point 3)", () => {
  it('answers a proof collected in full APPLIED with no reason', () => {
    expect(syncOutcomeOfProof({ codVarianceReasonCode: null, returnedReasonCode: null })).toEqual({ outcome: 'APPLIED', reason: null });
  });

  it('answers a short collection or a part delivery APPLIED_WITH_EXCEPTION naming each', () => {
    expect(syncOutcomeOfProof({ codVarianceReasonCode: 'CUSTOMER_PAID_SHORT', returnedReasonCode: null })).toEqual({ outcome: 'APPLIED_WITH_EXCEPTION', reason: 'COD_VARIANCE:CUSTOMER_PAID_SHORT' });
    expect(syncOutcomeOfProof({ codVarianceReasonCode: null, returnedReasonCode: 'CUSTOMER_REFUSED' })).toEqual({ outcome: 'APPLIED_WITH_EXCEPTION', reason: 'PART_DELIVERY:CUSTOMER_REFUSED' });
    expect(syncOutcomeOfProof({ codVarianceReasonCode: 'CUSTOMER_PAYS_LATER', returnedReasonCode: 'CUSTOMER_REFUSED' })).toEqual({ outcome: 'APPLIED_WITH_EXCEPTION', reason: 'COD_VARIANCE:CUSTOMER_PAYS_LATER PART_DELIVERY:CUSTOMER_REFUSED' });
  });
});
