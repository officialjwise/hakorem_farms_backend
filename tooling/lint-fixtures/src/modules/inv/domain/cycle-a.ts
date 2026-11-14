// expect: import-x/no-cycle
import { b } from './cycle-b';
export const a = (): string => b();
