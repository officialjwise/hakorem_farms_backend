// expect: hakorem/no-number-arithmetic-with-money
import { Money } from '@hakorem/kernel';
export function lineTotal(unitPrice: Money, quantity: number): Money {
  const pesewas = Number(unitPrice.pesewas) * quantity;
  return Money.fromJsonInteger(pesewas);
}
