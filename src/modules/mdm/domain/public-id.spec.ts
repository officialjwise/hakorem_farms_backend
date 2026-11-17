import { describe, expect, it } from 'vitest';
import { PUBLIC_ID_ALPHABET, publicIdFrom, readPublicId } from './public-id';

const bytes = (...values: number[]) => Uint8Array.from(values);
const sixteen = (value: number) => new Uint8Array(16).fill(value);

describe('public IDs of customers and suppliers (B09q, ADR-0073)', () => {
  it('writes a type prefix and sixteen Crockford base32 characters, five random bits each', () => {
    expect(publicIdFrom('CUSTOMER', bytes(8, 15, 3, 19, 2, 20, 9, 23, 7, 29, 4, 26, 1, 27, 6, 11))).toBe('cus_8F3K2M9Q7X4T1V6B');
    expect(publicIdFrom('SUPPLIER', sixteen(0))).toBe('sup_0000000000000000');
    expect(publicIdFrom('SUPPLIER', sixteen(31))).toBe('sup_ZZZZZZZZZZZZZZZZ');
  });

  it('uses only the low five bits of each byte, so every byte value maps evenly onto the 32 characters', () => {
    expect(publicIdFrom('CUSTOMER', sixteen(32))).toBe(publicIdFrom('CUSTOMER', sixteen(0)));
    expect(publicIdFrom('CUSTOMER', sixteen(255))).toBe(publicIdFrom('CUSTOMER', sixteen(31)));
    const counts = new Map<string, number>();
    for (let value = 0; value < 256; value += 1) {
      const character = publicIdFrom('CUSTOMER', sixteen(value)).at(-1)!;
      counts.set(character, (counts.get(character) ?? 0) + 1);
    }
    expect([...counts.values()]).toEqual(Array(32).fill(8));
  });

  it('never uses a letter that reads as a digit (I, L, O) or U', () => {
    expect(PUBLIC_ID_ALPHABET).toHaveLength(32);
    expect(PUBLIC_ID_ALPHABET).not.toMatch(/[ILOU]/);
    expect(new Set(PUBLIC_ID_ALPHABET).size).toBe(32);
  });

  it('refuses fewer than sixteen random bytes', () => {
    expect(() => publicIdFrom('CUSTOMER', new Uint8Array(15))).toThrow(/16 random bytes/);
  });

  it('reads one typed loosely: any case, spaces or hyphens, O for 0 and I or L for 1', () => {
    expect(readPublicId('CUSTOMER', 'cus_8F3K2M9Q7X4T1V6B')).toBe('cus_8F3K2M9Q7X4T1V6B');
    expect(readPublicId('CUSTOMER', ' CUS_8f3k-2m9q 7x4t-iv6b ')).toBe('cus_8F3K2M9Q7X4T1V6B');
    expect(readPublicId('CUSTOMER', 'cus_8F3K2M9Q7X4T1V6B'.replace('0', 'O'))).toBe('cus_8F3K2M9Q7X4T1V6B');
    expect(readPublicId('SUPPLIER', 'sup_oooo0000LLLL1111')).toBe('sup_0000000011111111');
  });

  it('reads nothing that is not a public ID of that kind', () => {
    for (const text of ['cus_8F3K2M9Q7X4T1V6', 'cus_8F3K2M9Q7X4T1V6BB', 'sup_8F3K2M9Q7X4T1V6B', 'cus_8F3K2M9Q7X4T1V6U', 'C-00001', 'Kofi Mensah', '0244123456', '']) {
      expect(readPublicId('CUSTOMER', text), text).toBeNull();
    }
  });
});
