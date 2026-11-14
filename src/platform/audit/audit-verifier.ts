import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { KeyObject } from 'node:crypto';
import type pg from 'pg';
import { anchorMessage, anchorSignatureValid, chainHash, GENESIS_HASH } from './audit-chain';

/** An event without a chain row after this long is reported (ADR-0006). */
export const UNSEALED_ALERT_SECONDS = 300;
const PAGE = 5_000;
const SCHEDULER_PRINCIPAL = '01900000-0000-7000-8000-000000000004';

export interface VerificationReport {
  readonly outcome: 'SUCCESS' | 'DRIFT';
  readonly checkedEvents: number;
  /** Chain positions whose event no longer hashes to what was sealed, or whose chain hash does not follow. */
  readonly tamperedSeqs: readonly string[];
  /** Missing positions in the sequence. */
  readonly gaps: readonly string[];
  readonly unsealedOlderThanAlert: number;
  readonly anchor: { readonly seq: string; readonly signatureValid: boolean; readonly matchesChain: boolean } | null;
}

interface ChainRow {
  seq: string;
  prev_hash: Buffer;
  chain_hash: Buffer;
  stored_hash: Buffer;
  recomputed_hash: Buffer;
}

/**
 * The nightly audit verification (ADR-0006). Recomputes every event's content hash and every chain hash, finds gaps
 * in the sequence and events left unsealed, checks the latest anchor's signature and that it matches the chain, and
 * records the outcome in `platform.job_run`. It reports; it never corrects (security architecture, principle 5).
 */
export class AuditVerifier {
  private readonly nextId: () => string;

  constructor(
    private readonly pool: pg.Pool,
    private readonly anchorPublicKeys: ReadonlyMap<string, KeyObject>,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  async verify(): Promise<VerificationReport> {
    const started = this.clock.now();
    const tamperedSeqs: string[] = [];
    const gaps: string[] = [];
    let previous: Buffer = GENESIS_HASH;
    let expected = 1n;
    let checkedEvents = 0;
    for (let after = 0n; ; ) {
      const { rows } = await this.pool.query<ChainRow>(
        `SELECT c.seq::text AS seq, c.prev_hash, c.chain_hash, e.content_hash AS stored_hash,
                platform.audit_event_content_hash(e) AS recomputed_hash
           FROM platform.audit_chain c JOIN platform.audit_event e ON e.id = c.audit_event_id
          WHERE c.seq > $1 ORDER BY c.seq LIMIT $2`,
        [after.toString(), PAGE],
      );
      for (const row of rows) {
        const seq = BigInt(row.seq);
        for (; expected < seq; expected += 1n) {
          gaps.push(expected.toString());
        }
        const contentChanged = !row.stored_hash.equals(row.recomputed_hash);
        const linkBroken = !row.prev_hash.equals(previous) || !row.chain_hash.equals(chainHash(row.prev_hash, row.stored_hash, seq));
        if (contentChanged || linkBroken) {
          tamperedSeqs.push(row.seq);
        }
        previous = row.chain_hash;
        expected = seq + 1n;
        checkedEvents += 1;
      }
      if (rows.length < PAGE) {
        break;
      }
      after = BigInt(rows.at(-1)!.seq);
    }
    const { rows: unsealed } = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.audit_event e
        WHERE e.recorded_at < $1 AND NOT EXISTS (SELECT 1 FROM platform.audit_chain c WHERE c.audit_event_id = e.id)`,
      [new Date(started.getTime() - UNSEALED_ALERT_SECONDS * 1_000)],
    );
    const anchor = await this.checkLatestAnchor();
    const outcome =
      tamperedSeqs.length === 0 && gaps.length === 0 && unsealed[0]!.n === 0 && (anchor === null || (anchor.signatureValid && anchor.matchesChain)) ? 'SUCCESS' : 'DRIFT';
    const report: VerificationReport = { outcome, checkedEvents, tamperedSeqs, gaps, unsealedOlderThanAlert: unsealed[0]!.n, anchor };
    await this.pool.query(
      `INSERT INTO platform.job_run (id, job_name, started_at, finished_at, outcome, summary, actor_id)
       VALUES ($1, 'audit-verify', $2, $3, $4, $5, $6)`,
      [this.nextId(), started, this.clock.now(), outcome, JSON.stringify(report), SCHEDULER_PRINCIPAL],
    );
    return report;
  }

  private async checkLatestAnchor(): Promise<VerificationReport['anchor']> {
    const { rows } = await this.pool.query<{ seq: string; chain_hash: Buffer; signature: Buffer; signing_key_id: string; anchored_at: Date; chain_now: Buffer | null }>(
      `SELECT a.seq::text AS seq, a.chain_hash, a.signature, a.signing_key_id, a.anchored_at, c.chain_hash AS chain_now
         FROM platform.audit_anchor a LEFT JOIN platform.audit_chain c ON c.seq = a.seq
        ORDER BY a.anchored_at DESC LIMIT 1`,
    );
    const latest = rows[0];
    if (latest === undefined) {
      return null;
    }
    const key = this.anchorPublicKeys.get(latest.signing_key_id);
    const signatureValid =
      key !== undefined && anchorSignatureValid(key, anchorMessage(BigInt(latest.seq), latest.chain_hash, latest.anchored_at, latest.signing_key_id), latest.signature);
    return { seq: latest.seq, signatureValid, matchesChain: latest.chain_now !== null && latest.chain_now.equals(latest.chain_hash) };
  }
}
