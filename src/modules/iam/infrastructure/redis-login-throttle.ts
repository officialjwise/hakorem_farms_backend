import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Realm } from '../../../platform/context/request-context';
import { ServiceUnavailableError } from '../../../platform/errors/api-error';
import { lockSecondsAfter } from '../domain/lockout';
import type { LoginThrottle, ThrottleState } from '../application/ports';

/** Consecutive failures are forgotten after a day without one. */
const FAILURE_MEMORY_SECONDS = 86_400;

/** Records a failure: increments the count, sets the lock if the schedule calls for one. Returns [count, lock ttl]. */
const RECORD_FAILURE = `
local failures = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
return failures
`;

function keyOf(realm: Realm, identifier: string): string {
  return createHash('sha256').update(`${realm}|${identifier}`).digest('hex');
}

/**
 * The SA-01 backoff in Redis, keyed by a hash of realm and identifier so identifiers with no account are throttled
 * exactly like real ones. Login fails closed: if Redis cannot be reached the request is refused (docs/API.md
 * section 12), as SERVICE_UNAVAILABLE.
 */
export class RedisLoginThrottle implements LoginThrottle {
  constructor(private readonly redis: Redis) {}

  async state(realm: Realm, identifier: string): Promise<ThrottleState> {
    const key = keyOf(realm, identifier);
    const ttl = await this.guard(() => this.redis.pttl(`login:lock:${key}`));
    return ttl > 0 ? { locked: true, retryAfterSeconds: Math.ceil(ttl / 1_000) } : { locked: false };
  }

  async recordFailure(realm: Realm, identifier: string): Promise<{ consecutiveFailures: number; lockedForSeconds: number }> {
    const key = keyOf(realm, identifier);
    const failures = Number(await this.guard(() => this.redis.eval(RECORD_FAILURE, 1, `login:fail:${key}`, String(FAILURE_MEMORY_SECONDS))));
    const lockedForSeconds = lockSecondsAfter(failures);
    if (lockedForSeconds > 0) {
      await this.guard(() => this.redis.set(`login:lock:${key}`, '1', 'EX', lockedForSeconds));
    }
    return { consecutiveFailures: failures, lockedForSeconds };
  }

  async reset(realm: Realm, identifier: string): Promise<void> {
    const key = keyOf(realm, identifier);
    await this.guard(() => this.redis.del(`login:fail:${key}`, `login:lock:${key}`));
  }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new ServiceUnavailableError('the login throttle is unavailable', [], { cause: error });
    }
  }
}
