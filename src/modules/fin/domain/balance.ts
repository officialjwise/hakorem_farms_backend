import { Money } from '@hakorem/kernel';
import type { Side } from './posting';

/** A balance as the contract shows it: never negative, with its side (ADR-0001: direction is a field, not a sign). */
export interface SidedBalance {
  readonly pesewas: bigint;
  readonly side: Side;
}

/**
 * Debits less credits as an amount and a side: a debit balance is `D`, a credit balance `C`, and a nil balance takes the
 * account's normal side, so a cash account at nil reads "0 D" and a payables account "0 C".
 */
export function sidedBalance(signedPesewas: bigint, normalSide: Side): SidedBalance {
  if (signedPesewas > 0n) return { pesewas: signedPesewas, side: 'D' };
  if (signedPesewas < 0n) return { pesewas: -signedPesewas, side: 'C' };
  return { pesewas: 0n, side: normalSide };
}

/** The signed effect of one line on a balance kept as debits less credits. */
export function signedLine(side: Side, pesewas: bigint): bigint {
  return side === 'D' ? pesewas : -pesewas;
}

/** An exact pesewa amount as the contract's JSON integer; refused beyond JavaScript's safe range rather than rounded. */
export function jsonPesewas(pesewas: bigint): number {
  return Money.ofPesewas(pesewas).toJsonInteger();
}
