import type { Clock } from '@hakorem/kernel';
import type pg from 'pg';
import type { Logger } from 'pino';

/** How long a read setting is reused before it is read again. A change made through AUD takes effect within this. */
const CACHE_MILLISECONDS = 30_000;

interface CachedValue {
  readonly value: unknown;
  readonly readAt: number;
}

/**
 * Typed settings (`platform.setting`). The code that reads a setting owns its documented default, so an absent row
 * means the default applies; a row, written only through the AUD module's audited administration, overrides it. A
 * branch row overrides the global one. Values are effective-dated by `valid_from`. A failed read falls back to the
 * default and is logged: a settings outage must not stop the counter.
 */
export class Settings {
  private readonly cache = new Map<string, CachedValue>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async integer(key: string, fallback: number, branchId: string | null = null): Promise<number> {
    const value = await this.read(key, branchId);
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;
  }

  async boolean(key: string, fallback: boolean, branchId: string | null = null): Promise<boolean> {
    const value = await this.read(key, branchId);
    return typeof value === 'boolean' ? value : fallback;
  }

  private async read(key: string, branchId: string | null): Promise<unknown> {
    const cacheKey = `${key}@${branchId ?? '*'}`;
    const now = this.clock.now().getTime();
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined && now - cached.readAt < CACHE_MILLISECONDS) {
      return cached.value;
    }
    try {
      const { rows } = await this.pool.query<{ value: unknown }>(
        `SELECT value FROM platform.setting
          WHERE key = $1 AND deleted_at IS NULL AND valid_from <= $3 AND (branch_id = $2 OR branch_id IS NULL)
          ORDER BY branch_id NULLS LAST, valid_from DESC
          LIMIT 1`,
        [key, branchId, new Date(now)],
      );
      const value = rows[0]?.value;
      this.cache.set(cacheKey, { value, readAt: now });
      return value;
    } catch (error) {
      this.logger.warn({ key, err: error }, 'setting could not be read; using its default');
      return undefined;
    }
  }
}
