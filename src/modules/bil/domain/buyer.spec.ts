import { describe, expect, it } from 'vitest';
import { buyerVerdict, maskTin } from './buyer';

/**
 * The business buyer named on a counter receipt (the owner's addition (2) to A-200, A-285 (c)): a name and a Ghana tax
 * identification number, so the buyer can reclaim the input tax. Every TIN here is invented: an obviously made-up run
 * of digits, never a real business's or person's.
 */
const GRA_TIN = `C${'0'.repeat(9)}1`;
const GHANA_CARD = `GHA-${'0'.repeat(8)}1-0`;

describe('buyerVerdict', () => {
  it('takes a name and a GRA TIN (a letter P, C, G, Q or V and ten digits) or a Ghana Card PIN, trimmed and upper-cased', () => {
    expect(buyerVerdict({ name: '  Adom Catering Services ', tin: ` ${GRA_TIN.toLowerCase()} ` })).toEqual({ ok: true, value: { name: 'Adom Catering Services', tin: GRA_TIN } });
    expect(buyerVerdict({ name: 'Ama Owusu', tin: GHANA_CARD })).toEqual({ ok: true, value: { name: 'Ama Owusu', tin: GHANA_CARD } });
    for (const letter of ['P', 'C', 'G', 'Q', 'V']) expect(buyerVerdict({ name: 'Buyer', tin: `${letter}${'0'.repeat(9)}7` }).ok).toBe(true);
    expect(buyerVerdict({ name: 'x'.repeat(160), tin: GRA_TIN }).ok).toBe(true);
  });

  it('refuses a TIN of any other form, naming the field', () => {
    for (const tin of ['', '   ', `C${'0'.repeat(9)}`, `C${'0'.repeat(11)}`, `X${'0'.repeat(10)}`, `${'0'.repeat(11)}`, `GHA-${'0'.repeat(8)}-0`, `GHA${'0'.repeat(9)}0`, `GHA-${'0'.repeat(9)}-00`, `C${'0'.repeat(4)} ${'0'.repeat(5)}`, `C${'0'.repeat(9)}O`]) {
      expect(buyerVerdict({ name: 'Adom Catering Services', tin }), tin).toEqual({ ok: false, rules: [{ field: 'tin', rule: 'BUYER_TIN_INVALID' }] });
    }
  });

  it('refuses a blank or overlong name, or one with a control character, and names both fields when both are wrong', () => {
    expect(buyerVerdict({ name: '  ', tin: GRA_TIN })).toEqual({ ok: false, rules: [{ field: 'name', rule: 'BUYER_NAME_INVALID' }] });
    expect(buyerVerdict({ name: 'x'.repeat(161), tin: GRA_TIN })).toEqual({ ok: false, rules: [{ field: 'name', rule: 'BUYER_NAME_INVALID' }] });
    expect(buyerVerdict({ name: 'Adom\nCatering', tin: GRA_TIN })).toEqual({ ok: false, rules: [{ field: 'name', rule: 'BUYER_NAME_INVALID' }] });
    expect(buyerVerdict({ name: '', tin: 'nope' })).toEqual({
      ok: false,
      rules: [
        { field: 'name', rule: 'BUYER_NAME_INVALID' },
        { field: 'tin', rule: 'BUYER_TIN_INVALID' },
      ],
    });
  });
});

describe('maskTin', () => {
  it('keeps only the last four characters, as MDM masks a customer TIN', () => {
    expect(maskTin(GRA_TIN)).toBe('*******0001');
    expect(maskTin(GHANA_CARD)).toBe('***********01-0');
    expect(maskTin(null)).toBeNull();
  });
});
