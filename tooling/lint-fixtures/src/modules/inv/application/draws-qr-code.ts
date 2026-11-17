// expect: no-restricted-imports
import { renderSVG } from 'uqr';
export const receiptQr = (link: string): string => renderSVG(link);
