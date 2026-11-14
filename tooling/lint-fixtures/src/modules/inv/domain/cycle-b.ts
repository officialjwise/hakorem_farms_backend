// expect: import-x/no-cycle
import { a } from './cycle-a';
export const b = (): string => typeof a;
