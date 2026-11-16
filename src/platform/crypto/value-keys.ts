import { decrypt, encrypt, newDataKey } from './envelope-cipher';
import type { KeyRing } from './key-ring';

/**
 * A Restricted value that belongs to no data subject (the farm's own account numbers, ADR-0057), sealed with a data key
 * of its own: AES-256-GCM under a fresh 256-bit key, bound to its place (column and row), and the key wrapped by the
 * active key-encryption key, bound to its row (ADR-0022). The three parts are stored side by side on the row.
 */
export interface SealedValue {
  readonly ciphertext: Buffer;
  readonly wrappedKey: Buffer;
  readonly kekVersion: number;
}

export function sealWithOwnKey(keyRing: KeyRing, plaintext: string, place: string, binding: string): SealedValue {
  const dataKey = newDataKey();
  const { wrapped, version } = keyRing.wrap(dataKey, binding);
  return { ciphertext: encrypt(dataKey, Buffer.from(plaintext, 'utf8'), place), wrappedKey: wrapped, kekVersion: version };
}

/** Opens a sealed value. Only the use case that needs the value calls this, under its own permission, audited as DECRYPT (SC-18). */
export function openWithOwnKey(keyRing: KeyRing, sealed: SealedValue, place: string, binding: string): string {
  const dataKey = keyRing.unwrap(sealed.wrappedKey, sealed.kekVersion, binding);
  return decrypt(dataKey, sealed.ciphertext, place).toString('utf8');
}
