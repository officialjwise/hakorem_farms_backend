import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { BreachedPasswords } from '../application/ports';

/**
 * The bundled fallback (ADR-0016): common passwords of at least twelve characters, the only ones the length rule
 * lets through, plus local favourites. Used when the range service is unreachable or switched off. Compared
 * case-insensitively. It is deliberately short; the range query is the real check.
 */
const COMMON_PASSWORDS: readonly string[] = [
  '123456789012', '1234567890123', '12345678901234', '123456789123', '111111111111', '000000000000', '123123123123',
  '1q2w3e4r5t6y', 'qwertyuiopas', 'qwertyuiop12', 'qwerty123456', 'asdfghjkl123', 'zxcvbnm12345', '1qaz2wsx3edc',
  'password1234', 'password12345', 'password123456', 'passwordpassword', 'password1password', 'p@ssw0rd1234',
  'iloveyou1234', 'iloveyou12345', 'welcome12345', 'welcome123456', 'letmein12345', 'changeme1234', 'administrator',
  'admin1234567', 'football1234', 'baseball1234', 'superman1234', 'sunshine1234', 'princess1234', 'monkey123456',
  'abcdefghijkl', 'abc123abc123', 'trustno1trustno1', 'masterkey123', 'computer1234', 'internet1234',
  'ghana1234567', 'ghana123456789', 'accra1234567', 'kumasi123456', 'blackstars12', 'blackstars123', 'godisgood123',
  'jesuslovesme', 'jesusislord1', 'hakoremfarms', 'hakorem12345', 'farmtotable1',
];

const COMMON = new Set(COMMON_PASSWORDS.map((password) => password.toLowerCase()));

export interface BreachedPasswordSettings {
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly timeoutMs: number;
}

/**
 * The breached-password check at set time (FR-IAM-005): a k-anonymity range query, which sends only the first five
 * characters of the password's SHA-1, then the bundled list when the service is off or unreachable.
 */
export class RangeQueryBreachedPasswords implements BreachedPasswords {
  constructor(
    private readonly settings: BreachedPasswordSettings,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async isBreached(password: string): Promise<boolean> {
    if (COMMON.has(password.toLowerCase())) {
      return true;
    }
    if (!this.settings.enabled) {
      return false;
    }
    const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);
    try {
      const response = await this.fetchImpl(`${this.settings.baseUrl}/${prefix}`, {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'hakorem-api' },
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`range query answered ${response.status}`);
      }
      const body = await response.text();
      return body.split('\n').some((line) => {
        const [candidate, count] = line.trim().split(':');
        return candidate === suffix && Number(count) > 0;
      });
    } catch (error) {
      this.logger.warn({ err: error }, 'breached-password range query unavailable; the bundled list was used');
      return false;
    }
  }
}
