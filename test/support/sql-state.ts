/** The SQLSTATE a query failed with, or undefined if it succeeded: for tests that expect the database to refuse. */
export async function sqlStateOf(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (error: unknown) => (error as { code?: string }).code,
  );
}

/** SQLSTATEs the tests name. */
export const SQLSTATE = {
  insufficientPrivilege: '42501',
  checkViolation: '23514',
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  /** platform.reject_change(): a LEDGER row cannot be updated, deleted or truncated. */
  ledgerImmutable: 'HK001',
  /** platform.touch_version(): optimistic lock. */
  versionConflict: 'HK002',
  /** A revoked session cannot change. */
  sessionRevoked: 'HK003',
  /** platform.freeze_posted(): a posted document cannot change. */
  documentFrozen: 'HK004',
  /** A destroyed subject key cannot change. */
  subjectKeyDestroyed: 'HK005',
} as const;
