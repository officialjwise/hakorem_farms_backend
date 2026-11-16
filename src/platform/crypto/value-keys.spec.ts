import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DecryptionError } from './envelope-cipher';
import { KeyRing } from './key-ring';
import { openWithOwnKey, sealWithOwnKey } from './value-keys';

const ringOf = (...versions: number[]) => new KeyRing(new Map(versions.map((v) => [v, randomBytes(32)] as const)), versions.at(-1)!);
const PLACE = 'fin.bank_account.account_no_enc:019a7a92-6491-77d8-bd10-86568cccff34';
const BINDING = 'fin.bank_account.account_no:019a7a92-6491-77d8-bd10-86568cccff34';

describe('a value sealed with a data key of its own (ADR-0022, ADR-0057)', () => {
  it('opens with its wrapped key, binding and place, and neither the ciphertext nor the wrapped key holds the value', () => {
    const ring = ringOf(1);
    const sealed = sealWithOwnKey(ring, '2040016620', PLACE, BINDING);
    expect(sealed.kekVersion).toBe(1);
    expect(sealed.ciphertext.includes(Buffer.from('2040016620'))).toBe(false);
    expect(sealed.wrappedKey.length).toBe(61);
    expect(openWithOwnKey(ring, sealed, PLACE, BINDING)).toBe('2040016620');
  });

  it('gives a fresh key and nonce to every value, so the same number seals differently twice', () => {
    const ring = ringOf(1);
    const a = sealWithOwnKey(ring, '2040016620', PLACE, BINDING);
    const b = sealWithOwnKey(ring, '2040016620', PLACE, BINDING);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedKey.equals(b.wrappedKey)).toBe(false);
  });

  it('refuses to open in another row, under another binding, after a changed byte, or with another key ring', () => {
    const ring = ringOf(1);
    const sealed = sealWithOwnKey(ring, '2040016620', PLACE, BINDING);
    expect(() => openWithOwnKey(ring, sealed, `${PLACE}x`, BINDING)).toThrow(DecryptionError);
    expect(() => openWithOwnKey(ring, sealed, PLACE, `${BINDING}x`)).toThrow(DecryptionError);
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() => openWithOwnKey(ring, { ...sealed, ciphertext: tampered }, PLACE, BINDING)).toThrow(DecryptionError);
    expect(() => openWithOwnKey(ringOf(1), sealed, PLACE, BINDING)).toThrow(DecryptionError);
  });
});
