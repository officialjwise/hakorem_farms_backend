import { hash, verify } from '@node-rs/argon2';
import type { PasswordHasher } from '../application/ports';

/** `Algorithm.Argon2id` of @node-rs/argon2, a const enum that isolated modules cannot read. */
const ARGON2ID = 2;

export interface Argon2Settings {
  readonly memoryKib: number;
  readonly iterations: number;
  readonly parallelism: number;
}

/**
 * Argon2id with a random salt per password (ADR-0016). Parameters come from ARGON2_* and are tuned to about 250 ms
 * on the production server (A-066); a hash made with older parameters still verifies, since they are in the hash.
 */
export class Argon2PasswordHasher implements PasswordHasher {
  private dummyHash: Promise<string> | undefined;

  constructor(private readonly settings: Argon2Settings) {}

  hash(password: string): Promise<string> {
    return hash(password, {
      algorithm: ARGON2ID,
      memoryCost: this.settings.memoryKib,
      timeCost: this.settings.iterations,
      parallelism: this.settings.parallelism,
    });
  }

  async verify(encodedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(encodedHash, password);
    } catch {
      return false;
    }
  }

  /** Verifies against a hash made once with the same parameters, so an unknown account costs the same time. */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash('hk-dummy-password-never-matches');
    await this.verify(await this.dummyHash, password);
  }
}
