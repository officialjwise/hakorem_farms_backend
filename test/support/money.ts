import { Money } from '@hakorem/kernel';

/** A movement's incoming value from a whole number of pesewas, for a test posting through INV's `Stock` (ADR-0001). */
export function pesewasValue(pesewas: number): Money {
  return Money.ofPesewas(BigInt(pesewas));
}
