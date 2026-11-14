import { decrypt, encrypt } from './envelope-cipher';

/**
 * The key-encryption keys (ADR-0022): held outside the database, injected as `KEK_V<n>` (base64 of 32 bytes), with
 * `KEK_ACTIVE_VERSION` naming the one that wraps new data keys. Old versions stay so old data keys still unwrap.
 */
export class KeyRing {
  constructor(
    private readonly keys: ReadonlyMap<number, Buffer>,
    readonly activeVersion: number,
  ) {
    if (!keys.has(activeVersion)) {
      throw new Error(`KEK_V${activeVersion} is not configured, but KEK_ACTIVE_VERSION names it`);
    }
  }

  /** Wraps a data key under the active key-encryption key, bound to the row it is stored in. */
  wrap(dataKey: Buffer, binding: string): { wrapped: Buffer; version: number } {
    return { wrapped: encrypt(this.key(this.activeVersion), dataKey, `kek:${binding}`), version: this.activeVersion };
  }

  unwrap(wrapped: Buffer, version: number, binding: string): Buffer {
    return decrypt(this.key(version), wrapped, `kek:${binding}`);
  }

  private key(version: number): Buffer {
    const key = this.keys.get(version);
    if (key === undefined) {
      throw new Error(`KEK_V${version} is not configured; it is needed to unwrap a data key`);
    }
    return key;
  }
}

const KEK_NAME = /^KEK_V([1-9][0-9]{0,3})$/;
const KEY_BYTES = 32;

/** Reads every `KEK_V<n>` from the environment. Reports a malformed key by name, never by value. */
export function keyRingFromEnvironment(env: NodeJS.ProcessEnv, activeVersion: number): KeyRing {
  const keys = new Map<number, Buffer>();
  for (const [name, value] of Object.entries(env)) {
    const match = KEK_NAME.exec(name);
    if (match === null || value === undefined || value === '') {
      continue;
    }
    const key = Buffer.from(value, 'base64');
    if (key.length !== KEY_BYTES || key.toString('base64') !== value) {
      throw new Error(`${name} must be the base64 of exactly ${KEY_BYTES} random bytes`);
    }
    keys.set(Number(match[1]), key);
  }
  return new KeyRing(keys, activeVersion);
}
