import type pg from 'pg';
import type { Logger } from 'pino';
import { chainHash, GENESIS_HASH } from './audit-chain';

/** One sealer at a time: the chain is a single sequence (ADR-0006). */
const SEALER_LOCK_KEY = 'hk.audit-sealer';

interface HeadRow {
  seq: string;
  chain_hash: Buffer;
  txid: string;
  audit_event_id: string;
}

interface EventRow {
  id: string;
  content_hash: Buffer;
}

/**
 * The audit sealer (ADR-0006, stage two). Runs as `hk_sealer`, at read committed, one process at a time. It chains
 * events whose transaction id is below the oldest transaction still running, in order of transaction id then event
 * id: no transaction with a lower id can still commit, so the order is final and every run reproduces it. Each
 * event's chain row carries the previous row's hash.
 */
export class AuditSealer {
  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: Logger,
    private readonly batchSize = 500,
  ) {}

  /** Seals what can be sealed now; returns how many events were chained. Another sealer running means 0. */
  async sealOnce(): Promise<number> {
    const client = await this.pool.connect();
    let locked = false;
    try {
      const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [SEALER_LOCK_KEY]);
      locked = lock.rows[0]?.ok === true;
      if (!locked) {
        return 0;
      }
      let total = 0;
      for (;;) {
        const sealed = await this.sealBatch(client);
        total += sealed;
        if (sealed < this.batchSize) {
          return total;
        }
      }
    } finally {
      if (locked) {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [SEALER_LOCK_KEY]).catch((error: unknown) => {
          this.logger.error({ err: error }, 'audit sealer could not release its lock');
        });
      }
      client.release();
    }
  }

  private async sealBatch(client: pg.PoolClient): Promise<number> {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    try {
      const { rows: heads } = await client.query<HeadRow>(
        `SELECT c.seq::text AS seq, c.chain_hash, e.txid::text AS txid, c.audit_event_id
           FROM platform.audit_chain c JOIN platform.audit_event e ON e.id = c.audit_event_id
          ORDER BY c.seq DESC LIMIT 1`,
      );
      const head = heads[0];
      const { rows } = await client.query<EventRow>(
        `SELECT e.id, e.content_hash
           FROM platform.audit_event e
          WHERE e.txid < pg_snapshot_xmin(pg_current_snapshot())
            AND ($1::xid8 IS NULL OR (e.txid, e.id) > ($1::xid8, $2::uuid))
          ORDER BY e.txid, e.id
          LIMIT $3`,
        [head?.txid ?? null, head?.audit_event_id ?? null, this.batchSize],
      );
      let previous = head?.chain_hash ?? GENESIS_HASH;
      let seq = head === undefined ? 0n : BigInt(head.seq);
      for (const row of rows) {
        seq += 1n;
        const hash = chainHash(previous, row.content_hash, seq);
        await client.query('INSERT INTO platform.audit_chain (seq, audit_event_id, prev_hash, chain_hash) VALUES ($1, $2, $3, $4)', [
          seq.toString(),
          row.id,
          previous,
          hash,
        ]);
        previous = hash;
      }
      await client.query('COMMIT');
      return rows.length;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
}
