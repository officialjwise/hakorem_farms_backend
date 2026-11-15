import { describe, expect, it } from 'vitest';
import { exceptionSummary, isHeldVariance, judgeResolution } from './stock-exception';

const held = { exceptionKind: 'TRANSFER_VARIANCE', held: true, hasDocument: false, hasFoundLocation: false, writeOffPending: false } as const;
const open = { exceptionKind: 'NEGATIVE_STOCK', held: false, hasDocument: false, hasFoundLocation: false, writeOffPending: false } as const;

describe('a held transfer variance is cleared only by a write-off or as found (ADR-0048)', () => {
  it('writing it off needs nothing else', () => {
    expect(judgeResolution({ ...held, requested: 'WRITE_OFF' })).toEqual({ kind: 'WRITE_OFF', broken: [] });
  });

  it('found needs where it was found, and a write-off names no such place', () => {
    expect(judgeResolution({ ...held, requested: 'FOUND', hasFoundLocation: true })).toEqual({ kind: 'FOUND', broken: [] });
    expect(judgeResolution({ ...held, requested: 'FOUND' }).broken).toEqual([{ field: '/foundLocationId', rule: 'FOUND_LOCATION_REQUIRED' }]);
    expect(judgeResolution({ ...held, requested: 'WRITE_OFF', hasFoundLocation: true }).broken).toEqual([{ field: '/foundLocationId', rule: 'ONLY_FOR_FOUND' }]);
  });

  it('a kind is required, and no other kind or a document of the caller is accepted', () => {
    expect(judgeResolution({ ...held, requested: undefined })).toEqual({ kind: null, broken: [{ field: '/resolutionKind', rule: 'RESOLUTION_KIND_REQUIRED' }] });
    expect(judgeResolution({ ...held, requested: 'NO_CORRECTION' }).broken).toEqual([{ field: '/resolutionKind', rule: 'NOT_FOR_A_HELD_VARIANCE' }]);
    expect(judgeResolution({ ...held, requested: 'ADJUSTED', hasDocument: true }).broken).toEqual([
      { field: '/resolutionKind', rule: 'NOT_FOR_A_HELD_VARIANCE' },
      { field: '/resolutionDocumentId', rule: 'NOT_FOR_A_HELD_VARIANCE' },
    ]);
  });

  it('nothing else is decided while a write-off waits for approval: neither found nor a second write-off', () => {
    expect(judgeResolution({ ...held, requested: 'FOUND', hasFoundLocation: true, writeOffPending: true }).broken).toEqual([{ field: '/resolutionKind', rule: 'WRITE_OFF_PENDING' }]);
    expect(judgeResolution({ ...held, requested: 'WRITE_OFF', writeOffPending: true }).broken).toEqual([{ field: '/resolutionKind', rule: 'WRITE_OFF_PENDING' }]);
  });
});

describe('any other exception is resolved as adjusted, with its adjustment, or with no correction (FR-INV-023)', () => {
  it('the kind follows the document when none is given', () => {
    expect(judgeResolution({ ...open, requested: undefined })).toEqual({ kind: 'NO_CORRECTION', broken: [] });
    expect(judgeResolution({ ...open, requested: undefined, hasDocument: true })).toEqual({ kind: 'ADJUSTED', broken: [] });
  });

  it('adjusted needs its document, no correction has none, and write-off and found are for held variances only', () => {
    expect(judgeResolution({ ...open, requested: 'ADJUSTED' }).broken).toEqual([{ field: '/resolutionDocumentId', rule: 'DOCUMENT_REQUIRED' }]);
    expect(judgeResolution({ ...open, requested: 'NO_CORRECTION', hasDocument: true }).broken).toEqual([{ field: '/resolutionDocumentId', rule: 'NOT_FOR_NO_CORRECTION' }]);
    expect(judgeResolution({ ...open, requested: 'WRITE_OFF' }).broken).toEqual([{ field: '/resolutionKind', rule: 'ONLY_FOR_A_HELD_VARIANCE' }]);
    expect(judgeResolution({ ...open, requested: 'FOUND', hasFoundLocation: true }).broken).toEqual([{ field: '/resolutionKind', rule: 'ONLY_FOR_A_HELD_VARIANCE' }]);
    expect(judgeResolution({ ...open, requested: 'NO_CORRECTION', hasFoundLocation: true }).broken).toEqual([{ field: '/foundLocationId', rule: 'ONLY_FOR_FOUND' }]);
  });
});

describe('what holds a variance, and how an exception is summed up', () => {
  it('a transfer variance with no movement is held; one posted as a loss before ADR-0048, or any other kind, is not', () => {
    expect(isHeldVariance({ kind: 'TRANSFER_VARIANCE', movementId: null })).toBe(true);
    expect(isHeldVariance({ kind: 'TRANSFER_VARIANCE', movementId: 'm' })).toBe(false);
    expect(isHeldVariance({ kind: 'NEGATIVE_STOCK', movementId: null })).toBe(false);
  });

  it('names the two facts of each kind', () => {
    expect(exceptionSummary({ kind: 'TRANSFER_VARIANCE', movementId: null, qty: '0.200', details: { qtyDispatched: '10.000', qtyReceived: '9.800' } })).toBe(
      'Received 9.800 of 10.000 dispatched; 0.200 held in transit until written off or found',
    );
    expect(exceptionSummary({ kind: 'TRANSFER_VARIANCE', movementId: 'm', qty: '0.200', details: { qtyDispatched: '10.000', qtyReceived: '9.800' } })).toBe(
      'Received 9.800 of 10.000 dispatched; 0.200 posted as a loss',
    );
    expect(exceptionSummary({ kind: 'NEGATIVE_STOCK', movementId: 'm', qty: '2.000', details: { movementType: 'SALE_ISSUE_OFFLINE', onHandAfter: '-2.000' } })).toBe(
      'SALE_ISSUE_OFFLINE took on hand to -2.000; the uncovered quantity carried no cost',
    );
    expect(exceptionSummary({ kind: 'RESERVATION_CONFLICT', movementId: 'm', qty: '1.000', details: { movementType: 'SALE_ISSUE_OFFLINE', onHandAfter: '2.000', reserved: '3.000' } })).toBe(
      'SALE_ISSUE_OFFLINE left 2.000 on hand against 3.000 reserved',
    );
    expect(exceptionSummary({ kind: 'BALANCE_DRIFT', movementId: null, qty: '2.000', details: { projection: 'BALANCE', projectedQty: '48.000', ledgerQty: '46.000' } })).toBe(
      'Nightly recompute: BALANCE 48.000, ledger 46.000; nothing was corrected',
    );
    expect(exceptionSummary({ kind: 'HOLD_CONFLICT', movementId: null, qty: null, details: { summary: 'Sold offline during its withdrawal period' } })).toBe('Sold offline during its withdrawal period');
    expect(exceptionSummary({ kind: 'BALANCE_DRIFT', movementId: null, qty: null, details: { projectedQty: 3 } })).toBe('Nightly recompute: ? 3, ledger ?; nothing was corrected');
    expect(exceptionSummary({ kind: 'SERIAL_CONFLICT', movementId: null, qty: null, details: {} })).toBe('SERIAL_CONFLICT: a stock fact that needs a person');
  });
});
