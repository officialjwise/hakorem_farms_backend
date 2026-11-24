import { allocate, Money } from '@hakorem/kernel';

/** An amount in equal monthly parts by `allocate`, the leftover pesewas to the earliest months; they sum to it exactly. */
export function equalMonthlyParts(pesewas: bigint, months: number): bigint[] {
  const shares = Array.from({ length: months }, (_, i) => ({ key: BigInt(i), weight: 1n }));
  const parts = allocate(Money.ofPesewas(pesewas), shares);
  if (!parts.ok) throw parts.error;
  return parts.value.map((part) => part.pesewas);
}
