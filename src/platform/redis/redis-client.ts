import { Redis } from 'ioredis';

/** Milliseconds a Redis command may take before it fails, so a stalled Redis cannot stall a request. */
const COMMAND_TIMEOUT_MS = 2_000;
const CONNECT_TIMEOUT_MS = 5_000;
/** Reconnect backoff: grows by this many milliseconds per attempt, up to the cap. */
const RECONNECT_STEP_MS = 200;
const RECONNECT_MAX_MS = 5_000;

/**
 * A command issued before the connection is ready waits in the offline queue rather than failing at once, so the
 * first health probe after start-up does not report Redis down; `commandTimeout` still bounds every command.
 * `keyPrefix` namespaces every key (REDIS_KEY_PREFIX): one per environment, and one per test app.
 */
export function createRedis(url: string, connectionName: string, keyPrefix = ''): Redis {
  return new Redis(url, {
    connectionName,
    keyPrefix,
    commandTimeout: COMMAND_TIMEOUT_MS,
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
    retryStrategy: (times) => Math.min(times * RECONNECT_STEP_MS, RECONNECT_MAX_MS),
  });
}
