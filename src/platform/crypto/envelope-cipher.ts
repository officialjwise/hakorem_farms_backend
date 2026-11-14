import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM with a random 96-bit nonce per value (ADR-0022). Stored form, one buffer:
 * `format (1 byte) | nonce (12) | tag (16) | ciphertext`. Associated data binds a value to where it belongs
 * (for example the column and row), so a ciphertext copied into another row does not decrypt.
 */
const FORMAT_V1 = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + NONCE_BYTES + TAG_BYTES;

export class DecryptionError extends Error {
  readonly code = 'DECRYPTION_FAILED';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DecryptionError';
  }
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new RangeError(`an AES-256 key is ${KEY_BYTES} bytes, not ${key.length}`);
  }
}

export function encrypt(key: Buffer, plaintext: Buffer, associatedData: string): Buffer {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_V1]), nonce, cipher.getAuthTag(), ciphertext]);
}

export function decrypt(key: Buffer, stored: Buffer, associatedData: string): Buffer {
  assertKey(key);
  if (stored.length < HEADER_BYTES || stored[0] !== FORMAT_V1) {
    throw new DecryptionError('the stored value is not in a known encrypted format');
  }
  const nonce = stored.subarray(1, 1 + NONCE_BYTES);
  const tag = stored.subarray(1 + NONCE_BYTES, HEADER_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(associatedData, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(stored.subarray(HEADER_BYTES)), decipher.final()]);
  } catch (error) {
    throw new DecryptionError('the value does not decrypt with this key and context', { cause: error });
  }
}

export function newDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}
