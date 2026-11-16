/**
 * Integer pesewas as printed on a document: `GHS 1,244.89`, a minus sign before the currency for a negative amount
 * (ADR-0001: the stored integer, never a float). Moved here from BIL in B08 continued 2c so every module that renders a
 * document (BIL, PUR's remittance advice, WHL's statements) prints an amount the same way.
 */
export function formatCedis(pesewas: bigint): string {
  const negative = pesewas < 0n;
  const abs = negative ? -pesewas : pesewas;
  const cedis = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rest = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}GHS ${cedis}.${rest}`;
}
