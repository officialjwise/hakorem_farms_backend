// expect: no-restricted-imports
import { renderSVG } from 'uqr';
export const labelQr = (payload: string): string => renderSVG(payload);
