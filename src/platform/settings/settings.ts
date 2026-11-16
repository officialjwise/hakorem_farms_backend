import type { Clock } from '@hakorem/kernel';
import type pg from 'pg';
import type { Logger } from 'pino';
import type { Transaction } from '../database/unit-of-work';

/** How long a read setting is reused before it is read again. A change made through AUD takes effect within this. */
const CACHE_MILLISECONDS = 30_000;

/** A setting row in force: what AUD's administration shows and replaces (FR-AUD-007). */
export interface SettingRow {
  readonly id: string;
  readonly key: string;
  readonly branchId: string | null;
  readonly value: unknown;
  readonly valueType: string;
  readonly validFrom: Date;
  readonly description: string;
  readonly version: number;
  readonly updatedAt: Date;
  readonly updatedBy: string;
}

export interface NewSettingRow {
  readonly id: string;
  readonly key: string;
  readonly branchId: string | null;
  readonly value: unknown;
  readonly valueType: string;
  readonly validFrom: Date;
  readonly description: string;
}

interface SettingDbRow {
  id: string;
  key: string;
  branch_id: string | null;
  value: unknown;
  value_type: string;
  valid_from: Date;
  description: string;
  version: number;
  updated_at: Date;
  updated_by: string;
}

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

  /** An integer in force at an instant, read fresh, never cached: a money rule such as an approval limit. */
  async integerAt(key: string, fallback: number, at: Date, branchId: string | null = null): Promise<number> {
    const value = await this.read(key, branchId, at);
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;
  }

  /**
   * The row in force for exactly this key and branch (a branch's own row, or the farm-wide row when `branchId` is null)
   * at an instant, in the caller's transaction; null when the default applies. For AUD's administration only.
   */
  async rowIn(tx: Transaction, key: string, branchId: string | null, at: Date): Promise<SettingRow | null> {
    const { rows } = await tx.query<SettingDbRow>(
      `SELECT id, key, branch_id, value, value_type, valid_from, description, version, updated_at, updated_by FROM platform.setting
        WHERE key = $1 AND branch_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL AND valid_from <= $3
        ORDER BY valid_from DESC LIMIT 1`,
      [key, branchId, at],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { id: row.id, key: row.key, branchId: row.branch_id, value: row.value, valueType: row.value_type, validFrom: row.valid_from, description: row.description, version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }

  /**
   * Writes a new effective-dated row in the caller's transaction; the rows before it stay, so what was in force when
   * stays answerable. Only AUD's audited administration calls this (FR-AUD-007).
   */
  async insertIn(tx: Transaction, row: NewSettingRow, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO platform.setting (id, key, branch_id, value, value_type, valid_from, description, created_by, updated_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $8)`,
      [row.id, row.key, row.branchId, JSON.stringify(row.value), row.valueType, row.validFrom, row.description, actorId],
    );
    this.cache.clear();
  }

  /** The value in force at a past or future instant, such as the start of a tax date. Read fresh, never cached. */
  async booleanAt(key: string, fallback: boolean, at: Date, branchId: string | null = null): Promise<boolean> {
    const value = await this.read(key, branchId, at);
    return typeof value === 'boolean' ? value : fallback;
  }

  private async read(key: string, branchId: string | null, at: Date | null = null): Promise<unknown> {
    const cacheKey = `${key}@${branchId ?? '*'}`;
    const now = this.clock.now().getTime();
    const cached = at === null ? this.cache.get(cacheKey) : undefined;
    if (cached !== undefined && now - cached.readAt < CACHE_MILLISECONDS) {
      return cached.value;
    }
    try {
      const { rows } = await this.pool.query<{ value: unknown }>(
        `SELECT value FROM platform.setting
          WHERE key = $1 AND deleted_at IS NULL AND valid_from <= $3 AND (branch_id = $2 OR branch_id IS NULL)
          ORDER BY branch_id NULLS LAST, valid_from DESC
          LIMIT 1`,
        [key, branchId, at ?? new Date(now)],
      );
      const value = rows[0]?.value;
      if (at === null) {
        this.cache.set(cacheKey, { value, readAt: now });
      }
      return value;
    } catch (error) {
      this.logger.warn({ key, err: error }, 'setting could not be read; using its default');
      return undefined;
    }
  }
}
