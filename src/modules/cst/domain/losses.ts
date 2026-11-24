import { Quantity } from '@hakorem/kernel';

/** One loss fact in its group: the group's id and label, the loss group, whether it reverses one, quantity and value. */
export interface LossFactInput {
  readonly groupId: string | null;
  readonly label: string;
  readonly lossGroup: 'MORTALITY' | 'SHRINKAGE' | 'WASTAGE';
  readonly isReversal: boolean;
  readonly qty: string;
  readonly value: bigint;
}

export interface LossRowFigures {
  readonly key: string;
  readonly groupId: string | null;
  readonly label: string;
  readonly lossGroup: 'MORTALITY' | 'SHRINKAGE' | 'WASTAGE';
  readonly events: number;
  readonly qty: string;
  readonly value: bigint;
}

/**
 * Losses by group (FR-CST-007), apart from cost of sales: each group's write-offs counted, with their quantity and
 * value summed exactly; a reversal takes its write-off back. A group left with no event is dropped. Rows keep the
 * order their first fact came in.
 */
export function lossRows(facts: readonly LossFactInput[]): LossRowFigures[] {
  const rows = new Map<string, { groupId: string | null; label: string; lossGroup: LossFactInput['lossGroup']; events: number; qty: bigint; value: bigint }>();
  for (const f of facts) {
    const key = `${f.groupId}|${f.label}|${f.lossGroup}`;
    const row = rows.get(key) ?? { groupId: f.groupId, label: f.label, lossGroup: f.lossGroup, events: 0, qty: 0n, value: 0n };
    const sign = f.isReversal ? -1 : 1;
    row.events += sign;
    row.qty += BigInt(sign) * Quantity.parse(f.qty).thousandths;
    row.value += BigInt(sign) * f.value;
    rows.set(key, row);
  }
  return [...rows.entries()]
    .filter(([, r]) => r.events > 0)
    .map(([key, r]) => ({ key, groupId: r.groupId, label: r.label, lossGroup: r.lossGroup, events: r.events, qty: Quantity.ofThousandths(r.qty).toDecimalString(), value: r.value }));
}
