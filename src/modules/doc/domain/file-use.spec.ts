import { describe, expect, it } from 'vitest';
import { capFor, DOCUMENT_CAP_BYTES, FILE_PURPOSES, FILE_USES, IMAGE_CAP_BYTES, isQuarantined, isServable, judgeUpload, LARGEST_CAP_BYTES } from './file-use';

const MB = 1_048_576;

describe('what each use of the file store accepts (FR-DOC-006, SA-11, SEC-027)', () => {
  it('caps images at exactly 5 MB and PDF and spreadsheets at exactly 10 MB', () => {
    expect(IMAGE_CAP_BYTES).toBe(5_242_880);
    expect(DOCUMENT_CAP_BYTES).toBe(10_485_760);
    expect(LARGEST_CAP_BYTES).toBe(10_485_760);
    expect(capFor('image/jpeg')).toBe(5 * MB);
    expect(capFor('application/pdf')).toBe(10 * MB);
  });

  it('accepts a file of exactly the cap and refuses one byte more', () => {
    expect(judgeUpload('EVIDENCE', 'image/jpeg', 5 * MB)).toMatchObject({ allowed: true });
    expect(judgeUpload('EVIDENCE', 'image/jpeg', 5 * MB + 1)).toEqual({ allowed: false, refusal: 'PAYLOAD_TOO_LARGE' });
    expect(judgeUpload('SUPPLIER_INVOICE', 'application/pdf', 10 * MB)).toMatchObject({ allowed: true });
    expect(judgeUpload('SUPPLIER_INVOICE', 'application/pdf', 12 * MB)).toEqual({ allowed: false, refusal: 'PAYLOAD_TOO_LARGE' });
  });

  it('refuses a ZIP or an unrecognised file for a photograph, whatever it was named', () => {
    expect(judgeUpload('PRODUCT_IMAGE', 'application/zip', 1_024)).toEqual({ allowed: false, refusal: 'FILE_TYPE_NOT_ALLOWED' });
    expect(judgeUpload('PRODUCT_IMAGE', null, 1_024)).toEqual({ allowed: false, refusal: 'FILE_TYPE_NOT_ALLOWED' });
    expect(judgeUpload('PRODUCT_IMAGE', 'application/pdf', 1_024)).toEqual({ allowed: false, refusal: 'FILE_TYPE_NOT_ALLOWED' });
  });

  it('takes spreadsheets only for imports, and PDF only where a document is expected', () => {
    expect(judgeUpload('IMPORT', 'text/csv', 2_048)).toMatchObject({ allowed: true, use: { classification: 'CONFIDENTIAL', keyPrefix: 'import' } });
    expect(judgeUpload('IMPORT', 'image/png', 2_048)).toEqual({ allowed: false, refusal: 'FILE_TYPE_NOT_ALLOWED' });
    expect(judgeUpload('STATEMENT', 'application/pdf', 2_048)).toMatchObject({ allowed: true });
    expect(judgeUpload('SIGNATURE', 'image/webp', 2_048)).toEqual({ allowed: false, refusal: 'FILE_TYPE_NOT_ALLOWED' });
  });

  it('refuses an empty file', () => {
    expect(judgeUpload('EVIDENCE', 'image/png', 0)).toEqual({ allowed: false, refusal: 'EMPTY_FILE' });
  });

  it('classifies only product photographs as public; every other use is confidential', () => {
    const publicUses = FILE_PURPOSES.filter((purpose) => FILE_USES[purpose].classification === 'PUBLIC');
    expect(publicUses).toEqual(['PRODUCT_IMAGE']);
    expect(new Set(FILE_PURPOSES.map((purpose) => FILE_USES[purpose].keyPrefix)).size).toBe(FILE_PURPOSES.length);
  });

  it('serves only CLEAN files and quarantines INFECTED and FAILED ones', () => {
    expect([isServable('CLEAN'), isServable('PENDING'), isServable('INFECTED'), isServable('FAILED')]).toEqual([true, false, false, false]);
    expect([isQuarantined('CLEAN'), isQuarantined('PENDING'), isQuarantined('INFECTED'), isQuarantined('FAILED')]).toEqual([false, false, true, true]);
  });
});
