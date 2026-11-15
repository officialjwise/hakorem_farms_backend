import { Money } from '@hakorem/kernel';

/** Pesewas as the contract's JSON integer (`Pesewas`); refuses anything outside the exact range (ADR-0036). */
export function jsonPesewas(pesewas: bigint): number;
export function jsonPesewas(pesewas: bigint | null): number | null;
export function jsonPesewas(pesewas: bigint | null): number | null {
  return pesewas === null ? null : Money.ofPesewas(pesewas).toJsonInteger();
}
