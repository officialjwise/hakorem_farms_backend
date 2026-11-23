import { halfUpDivide } from '@hakorem/kernel';

/*
 * The quote pipeline (FR-QUO-013), in counts of quotes: no amount is computed here but sums of the gross of whole
 * versions, in bigint pesewas.
 */
/** The statuses a quote ever issued can stand at in the pipeline; a withdrawn quote is neither won nor lost (A-329). */
export type PipelineStatus = 'ISSUED' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'CONVERTED';

export interface PipelineFigures {
  readonly issued: number;
  readonly accepted: number;
  readonly declined: number;
  readonly expired: number;
  readonly converted: number;
  readonly winRatePercent: string;
  readonly issuedValuePesewas: bigint;
  readonly wonValuePesewas: bigint;
}

/**
 * One row of the quote pipeline (FR-QUO-013) from its cells, each a status with how many quotes and their gross: every
 * quote issued, accepted (a converted quote was accepted first), declined, expired and converted, the win rate
 * accepted over accepted plus declined plus expired, half-up once to two places ("0.00" with nothing closed), the value
 * of every quote issued and of those won.
 */
export function pipelineFigures(cells: readonly { readonly status: PipelineStatus; readonly count: number; readonly grossPesewas: bigint }[]): PipelineFigures {
  const n = (s: PipelineStatus) => cells.filter((c) => c.status === s).reduce((a, c) => a + c.count, 0);
  const value = (s: readonly PipelineStatus[]) => cells.filter((c) => s.includes(c.status)).reduce((a, c) => a + c.grossPesewas, 0n);
  const accepted = n('ACCEPTED') + n('CONVERTED');
  const closed = accepted + n('DECLINED') + n('EXPIRED');
  const hundredths = closed === 0 ? 0n : halfUpDivide(BigInt(accepted) * 10_000n, BigInt(closed));
  return {
    issued: cells.reduce((a, c) => a + c.count, 0),
    accepted,
    declined: n('DECLINED'),
    expired: n('EXPIRED'),
    converted: n('CONVERTED'),
    winRatePercent: `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`,
    issuedValuePesewas: value(['ISSUED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CONVERTED']),
    wonValuePesewas: value(['ACCEPTED', 'CONVERTED']),
  };
}

const DAY_MS = 86_400_000;

/** The instants of a period of Accra calendar dates, both included: from the start of `from` to the end of `to`. */
export function pipelinePeriod(from: string, to: string): { readonly from: Date; readonly to: Date } {
  // Africa/Accra is UTC all year (ADR-0067).
  return { from: new Date(`${from}T00:00:00.000Z`), to: new Date(Date.parse(`${to}T00:00:00.000Z`) + DAY_MS) };
}

/** One page of the pipeline's ordered rows from `offset`, and the offset of the next page, or null when none follows. */
export function offsetPage<T>(rows: readonly T[], offset: number, limit: number): { readonly page: readonly T[]; readonly next: number | null } {
  const end = offset + limit;
  return { page: rows.slice(offset, end), next: end < rows.length ? end : null };
}
