import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

/**
 * Endpoint groups of docs/API.md section 12. Each names who it counts by and what happens when Redis is down:
 * sensitive groups fail closed (the request is refused), the rest fail open.
 */
export type RateLimitGroup = 'auth' | 'console' | 'public' | 'health';

export interface RateLimitRule {
  /** Settings key holding the limit, so the owner can change it without a deployment (`platform.setting`). */
  readonly settingKey: string;
  readonly defaultLimit: number;
  readonly windowSeconds: number;
  readonly failClosed: boolean;
}

/** The B3 defaults, recorded in docs/OPERATIONS.md. Login also has the per-account backoff of SA-01, in IAM. */
export const RATE_LIMIT_RULES: Readonly<Record<RateLimitGroup, RateLimitRule>> = {
  auth: { settingKey: 'rate_limit.auth.per_address_15m', defaultLimit: 20, windowSeconds: 900, failClosed: true },
  console: { settingKey: 'rate_limit.console.per_account_1m', defaultLimit: 600, windowSeconds: 60, failClosed: false },
  public: { settingKey: 'rate_limit.public.per_address_1m', defaultLimit: 300, windowSeconds: 60, failClosed: false },
  health: { settingKey: 'rate_limit.health.per_address_1m', defaultLimit: 60, windowSeconds: 60, failClosed: false },
};

export type RateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number; readonly reason: 'LIMIT' | 'UNAVAILABLE' };

/** Increments the window counter and sets its expiry on first use, atomically. Returns [count, ttl seconds]. */
const CONSUME_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
return {count, ttl}
`;

/** Seconds a client is told to wait when Redis is unavailable and the group fails closed. */
const UNAVAILABLE_RETRY_SECONDS = 30;

/** Fixed-window counters in Redis (security architecture section 5). */
export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  async consume(name: string, subject: string, limit: number, windowSeconds: number, failClosed: boolean): Promise<RateDecision> {
    const key = `rl:${name}:${subject}`;
    try {
      const [count, ttl] = (await this.redis.eval(CONSUME_SCRIPT, 1, key, String(windowSeconds))) as [number, number];
      if (count > limit) {
        return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds, reason: 'LIMIT' };
      }
      return { allowed: true };
    } catch (error) {
      this.logger.warn({ limiter: name, failClosed, err: error }, 'rate limiter unavailable');
      return failClosed ? { allowed: false, retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS, reason: 'UNAVAILABLE' } : { allowed: true };
    }
  }
}
