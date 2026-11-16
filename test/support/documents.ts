import type { ManualClock } from '@hakorem/kernel';
import { AuditTrail } from '../../src/platform/audit/audit-trail';
import { runAsSystem } from '../../src/platform/context/request-context';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { DomainEvents } from '../../src/platform/events/domain-events';
import { DISPATCHER_PRINCIPAL, OutboxDispatcher, type DispatchOutcome, type DispatcherSettings } from '../../src/platform/events/outbox-dispatcher';
import { FileScanner } from '../../src/platform/storage/file-scanner';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/platform/storage/object-storage';
import { CleanScanner } from './imports';
import type { TestApp } from './test-app';
import type { TestDatabase } from './test-database';

/** The worker's outbox settings as configured by default: eight attempts, backoff from one second to a minute. */
export const DISPATCH_SETTINGS: DispatcherSettings = { maxAttempts: 8, backoffBaseMs: 1_000, backoffMaxMs: 60_000, batchSize: 200 };

/**
 * The worker's two passes a rendered document goes through, run by hand: the outbox dispatcher (DOC renders and
 * archives, BIL links the archive) and the malware scan (CLEAN, so the archived file can be served).
 */
export interface DocumentWorker {
  dispatch(): Promise<DispatchOutcome>;
  scan(): Promise<number>;
  /** Dispatches until a pass delivers nothing, then scans: every pending render archived, linked and servable. */
  settle(): Promise<void>;
}

export function documentWorker(api: TestApp, database: TestDatabase, clock: ManualClock, events: DomainEvents = api.app.get(DomainEvents)): DocumentWorker {
  const uow = api.app.get(UnitOfWork);
  const dispatcher = new OutboxDispatcher(uow, events, clock, api.logger, DISPATCH_SETTINGS, () => 0.5);
  const workerPool = database.pool('worker');
  const scanner = new FileScanner(workerPool, new UnitOfWork(workerPool, api.logger), api.app.get<ObjectStorage>(OBJECT_STORAGE), new CleanScanner(), api.app.get(AuditTrail), clock, api.logger);
  const dispatch = () => runAsSystem(DISPATCHER_PRINCIPAL, 'test-dispatch', () => dispatcher.dispatchOnce());
  return {
    dispatch,
    scan: async () => (await scanner.scanPending(500)).clean,
    async settle() {
      for (let pass = 0; pass < 10; pass += 1) {
        const outcome = await dispatch();
        if (outcome.delivered === 0 && outcome.failed === 0) break;
      }
      await scanner.scanPending(500);
    },
  };
}
