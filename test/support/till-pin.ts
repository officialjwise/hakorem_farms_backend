import { pbkdf2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { Server } from 'node:http';
import { consolePut, type TestSession } from './iam';

const derive = promisify(pbkdf2);

/** The body `setTillPin` takes: what a till derives from a PIN typed into it (ADR-0080). Test PINs only. */
export interface TillPinBody {
  readonly algorithm: string;
  readonly iterations: number;
  readonly pinSalt: string;
  readonly pinHash: string;
}

/** Derives a verifier as the till does: PBKDF2-HMAC-SHA256 over the PIN's UTF-8 bytes, a random salt, a 32-byte key. */
export async function tillVerifier(pin: string, options: { readonly iterations?: number; readonly saltBytes?: number; readonly salt?: Buffer } = {}): Promise<TillPinBody> {
  const iterations = options.iterations ?? 600_000;
  const salt = options.salt ?? randomBytes(options.saltBytes ?? 16);
  const hash = await derive(pin, salt, iterations, 32, 'sha256');
  return { algorithm: 'PBKDF2-SHA256', iterations, pinSalt: salt.toString('base64'), pinHash: hash.toString('base64') };
}

/** Sets the session's own till PIN through the API. */
export function setTillPin(server: Server, session: TestSession, body: TillPinBody) {
  return consolePut(server, session, '/v1/pos/till-pin').send(body);
}
