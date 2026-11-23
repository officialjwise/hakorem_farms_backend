import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { codVariance, judgeProof, takesProof, type ProofFacts } from './deliveries';

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
