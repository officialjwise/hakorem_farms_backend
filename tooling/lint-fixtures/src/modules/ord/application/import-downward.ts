// expect: none
import { INV_PUBLIC } from '../../inv/index';
import type { StockMovementPosted } from '../../inv/events';
export const downward: string = INV_PUBLIC;
export type Subscribed = StockMovementPosted;
