import { Money, Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { claimedPart, claimLineValue, judgeClaimCredit, judgeClaimCreditApprover, judgeClaimSettledByInvoice, receivedPartValue } from './claim';

const q = (text: string) => Quantity.parse(text);
const crate = { unitPrice: Money.ofPesewas(4_751n), qtyOrdered: q('1.000'), qtyOrderedBase: q('30.000') };

describe('a claim line is the delivery at the order price, split exactly between accepted and rejected (ADR-0076)', () => {
  it('splits a crate at 4,751 with 7 of 30 eggs rejected into 3,642 accepted and 1,109 claimed', () => {
    const value = claimLineValue({ ...crate, qtyAcceptedBase: q('23.000'), qtyRejectedBase: q('7.000') });
    expect([value.lineValue.pesewas, value.accepted.pesewas, value.claimed.pesewas]).toEqual([4_751n, 3_642n, 1_109n]);
  });

  it('claims exactly a crate at 4,751 when one of three crates is rejected', () => {
    const value = claimLineValue({ unitPrice: Money.ofPesewas(4_751n), qtyOrdered: q('3.000'), qtyOrderedBase: q('90.000'), qtyAcceptedBase: q('60.000'), qtyRejectedBase: q('30.000') });
    expect([value.lineValue.pesewas, value.accepted.pesewas, value.claimed.pesewas]).toEqual([14_253n, 9_502n, 4_751n]);
  });

  it('rounds the delivery half-up once: one and a half crates at 4,751 is 7,127, never 7,126', () => {
    const value = claimLineValue({ ...crate, qtyAcceptedBase: q('30.000'), qtyRejectedBase: q('15.000') });
    expect([value.lineValue.pesewas, value.accepted.pesewas, value.claimed.pesewas]).toEqual([7_127n, 4_751n, 2_376n]);
  });

  it('gives an exact half pesewa of the split to the accepted share, as half-up does: 15 of 30 eggs at 4,751', () => {
    const value = claimLineValue({ ...crate, qtyAcceptedBase: q('15.000'), qtyRejectedBase: q('15.000') });
    expect([value.accepted.pesewas, value.claimed.pesewas]).toEqual([2_376n, 2_375n]);
  });

  it('rounds the accepted share down one below a half and up one above it', () => {
    // 4,751 x 1/30 = 158.37, below a half: down to 158.
    const one = claimLineValue({ ...crate, qtyAcceptedBase: q('1.000'), qtyRejectedBase: q('29.000') });
    expect([one.accepted.pesewas, one.claimed.pesewas]).toEqual([158n, 4_593n]);
    // 4,751 x 2/30 = 316.73: up to 317.
    const two = claimLineValue({ ...crate, qtyAcceptedBase: q('2.000'), qtyRejectedBase: q('28.000') });
    expect([two.accepted.pesewas, two.claimed.pesewas]).toEqual([317n, 4_434n]);
  });

  it('claims the whole line when nothing was accepted and nothing when nothing was rejected', () => {
    const all = claimLineValue({ ...crate, qtyAcceptedBase: q('0.000'), qtyRejectedBase: q('30.000') });
    expect([all.accepted.pesewas, all.claimed.pesewas]).toEqual([0n, 4_751n]);
    const none = claimLineValue({ ...crate, qtyAcceptedBase: q('30.000'), qtyRejectedBase: q('0.000') });
    expect([none.accepted.pesewas, none.claimed.pesewas]).toEqual([4_751n, 0n]);
  });

  it('refuses a delivery of nothing', () => {
    expect(() => claimLineValue({ ...crate, qtyAcceptedBase: q('0.000'), qtyRejectedBase: q('0.000') })).toThrow();
  });

  it('refuses a negative quantity, which allocate never splits', () => {
    expect(() => claimLineValue({ ...crate, qtyAcceptedBase: q('-1.000'), qtyRejectedBase: q('31.000') })).toThrow('ALLOCATION_NEGATIVE_WEIGHT');
  });
});

describe('an invoice line that carries a claimed quantity clears 2010 only for what was received (ADR-0076)', () => {
  it('values the 23 received eggs of a crate invoiced whole at 4,751 at 3,642', () => {
    expect(receivedPartValue(Money.ofPesewas(4_751n), q('1.000'), q('30.000'), q('7.000')).pesewas).toBe(3_642n);
  });

  it('refuses an invoice line of no quantity', () => {
    expect(() => receivedPartValue(Money.ofPesewas(4_751n), q('1.000'), q('0.000'), q('0.000'))).toThrow();
  });

  it('values the received two of three crates invoiced at 4,751 at 9,502', () => {
    expect(receivedPartValue(Money.ofPesewas(4_751n), q('3.000'), q('90.000'), q('30.000')).pesewas).toBe(9_502n);
  });

  it('takes the claimed part of a line from its quantity variance, never more than the line and never below zero', () => {
    expect(claimedPart(q('7.000'), q('30.000')).toDecimalString()).toBe('7.000');
    expect(claimedPart(q('40.000'), q('30.000')).toDecimalString()).toBe('30.000');
    expect(claimedPart(q('-5.000'), q('30.000')).toDecimalString()).toBe('0.000');
    expect(claimedPart(null, q('30.000')).toDecimalString()).toBe('0.000');
  });
});

describe('a claim is settled once, by the invoice that left the rejected goods out or a credit note against one that charged them', () => {
  const facts = { received: q('23.000'), creditedByOtherClaims: q('0.000') };

  it('drafts a credit note only when the supplier charged the rejected eggs beyond what was received', () => {
    expect(judgeClaimCredit({ ...facts, invoiced: q('30.000'), claimQty: q('7.000') }).ok).toBe(true);
    expect(judgeClaimCredit({ ...facts, invoiced: q('29.000'), claimQty: q('7.000') })).toEqual({ ok: false, error: 'CLAIM_NOT_INVOICED' });
    expect(judgeClaimCredit({ ...facts, invoiced: q('23.000'), claimQty: q('7.000') })).toEqual({ ok: false, error: 'CLAIM_NOT_INVOICED' });
  });

  it('counts eggs another claim already credited, so the same eggs are never credited twice', () => {
    expect(judgeClaimCredit({ received: q('23.000'), invoiced: q('30.000'), creditedByOtherClaims: q('7.000'), claimQty: q('7.000') })).toEqual({ ok: false, error: 'CLAIM_NOT_INVOICED' });
    expect(judgeClaimCredit({ received: q('16.000'), invoiced: q('30.000'), creditedByOtherClaims: q('7.000'), claimQty: q('7.000') }).ok).toBe(true);
  });

  it('settles by the invoice only when nothing beyond what was received, and what credits cover, was invoiced', () => {
    expect(judgeClaimSettledByInvoice({ ...facts, invoiced: q('23.000') }).ok).toBe(true);
    expect(judgeClaimSettledByInvoice({ ...facts, invoiced: q('20.000') }).ok).toBe(true);
    expect(judgeClaimSettledByInvoice({ ...facts, invoiced: q('23.001') })).toEqual({ ok: false, error: 'CLAIM_INVOICED' });
    expect(judgeClaimSettledByInvoice({ received: q('23.000'), invoiced: q('30.000'), creditedByOtherClaims: q('7.000') }).ok).toBe(true);
  });
});

describe('the approver of a claim credit note is none of the people who made it (ADR-0017, ADR-0076)', () => {
  const people = { creditMakerId: 'maker', requesterId: 'submitter', claimMakerId: 'claimer', receiverId: 'receiver' };

  it('accepts a fifth person', () => {
    expect(judgeClaimCreditApprover({ ...people, approverId: 'checker' }).ok).toBe(true);
  });

  it('refuses the submitter, the credit note maker, the claim maker and the receiver', () => {
    expect(judgeClaimCreditApprover({ ...people, approverId: 'submitter' })).toEqual({ ok: false, error: 'MAKER_CANNOT_CHECK' });
    expect(judgeClaimCreditApprover({ ...people, approverId: 'maker' })).toEqual({ ok: false, error: 'INVOICE_MAKER_CANNOT_APPROVE' });
    expect(judgeClaimCreditApprover({ ...people, approverId: 'claimer' })).toEqual({ ok: false, error: 'INVOICE_MAKER_CANNOT_APPROVE' });
    expect(judgeClaimCreditApprover({ ...people, approverId: 'receiver' })).toEqual({ ok: false, error: 'INVOICE_MAKER_CANNOT_APPROVE' });
  });

  it('judges a credit note with no claim as before', () => {
    expect(judgeClaimCreditApprover({ creditMakerId: 'maker', requesterId: 'submitter', claimMakerId: null, receiverId: null, approverId: 'checker' }).ok).toBe(true);
  });
});
