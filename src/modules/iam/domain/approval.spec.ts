import { describe, expect, it } from 'vitest';
import { decideApproval, type ApprovalState } from './approval';

const MAKER = '019a7a86-8d13-7ec4-93fc-f519f70a6df7';
const CHECKER = '019a7a86-4f35-7afd-b035-b8ab03a83188';
const HASH = 'a3f1'.repeat(16);

const pending: ApprovalState = {
  status: 'PENDING',
  requestedBy: MAKER,
  payloadHash: HASH,
  expiresAt: new Date('2026-11-15T12:00:00Z'),
};
const now = new Date('2026-11-14T12:00:00Z');

describe('deciding an approval request (ADR-0017)', () => {
  it('lets a different person approve a pending request whose subject is unchanged', () => {
    expect(decideApproval(pending, { decidedBy: CHECKER, decision: 'APPROVED', currentPayloadHash: HASH, now })).toEqual({ ok: true });
  });

  it('refuses the maker as checker', () => {
    expect(decideApproval(pending, { decidedBy: MAKER, decision: 'APPROVED', currentPayloadHash: HASH, now })).toEqual({
      ok: false,
      code: 'MAKER_CANNOT_CHECK',
    });
  });

  it('refuses a request already decided', () => {
    expect(decideApproval({ ...pending, status: 'REJECTED' }, { decidedBy: CHECKER, decision: 'APPROVED', currentPayloadHash: HASH, now })).toEqual({
      ok: false,
      code: 'APPROVAL_ALREADY_DECIDED',
    });
  });

  it('refuses a request that lapsed before it was decided', () => {
    expect(
      decideApproval(pending, { decidedBy: CHECKER, decision: 'APPROVED', currentPayloadHash: HASH, now: new Date('2026-11-15T12:00:00Z') }),
    ).toEqual({ ok: false, code: 'APPROVAL_EXPIRED' });
  });

  it('voids the approval when the subject changed after the request, so nobody approves something else', () => {
    expect(decideApproval(pending, { decidedBy: CHECKER, decision: 'APPROVED', currentPayloadHash: 'b4e2'.repeat(16), now })).toEqual({
      ok: false,
      code: 'APPROVAL_SUBJECT_CHANGED',
    });
  });

  it('lets a different person reject even a changed subject, since a rejection takes no effect', () => {
    expect(decideApproval(pending, { decidedBy: CHECKER, decision: 'REJECTED', currentPayloadHash: 'b4e2'.repeat(16), now })).toEqual({ ok: true });
  });
});
