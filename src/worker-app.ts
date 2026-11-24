import type { Clock } from '@hakorem/kernel';
import { systemClock } from '@hakorem/kernel';
import { NestFactory } from '@nestjs/core';
import type pg from 'pg';
import type { Logger } from 'pino';
import { AppModule } from './app.module';
import type { AppConfig } from './platform/config/app-config';
import { createPool } from './platform/database/database-pool';
import { UnitOfWork } from './platform/database/unit-of-work';
import { DomainEvents } from './platform/events/domain-events';
import { NestPinoLogger } from './platform/logging/nest-logger';
import { OtelMetrics } from './platform/observability/metrics';
import { LOGGER, PG_POOL } from './platform/platform.module';
import { AuditTrail } from './platform/audit/audit-trail';
import { FileScanner } from './platform/storage/file-scanner';
import { SharpImageRenderer } from './platform/storage/image-renderer';
import { ClamdScanner } from './platform/storage/malware-scanner';
import { OBJECT_STORAGE, type ObjectStorage } from './platform/storage/object-storage';
import { BullmqJobQueue } from './platform/queue/job-queue';
import { S3ObjectStorage } from './platform/storage/s3-object-storage';
import { WorkerRuntime, type ScheduledJob } from './platform/worker/worker-runtime';
import { BillingNumberingAudit } from './modules/bil';
import { LedgerReconciliation } from './modules/fin';
import { BalanceReconciliation, ReservationExpiry, StockAlertSweep } from './modules/inv';
import { MortalityEvidenceReturns } from './modules/liv';
import { QuoteExpiry } from './modules/quo';
import { AccountHolds, Dunning, StandingOrders } from './modules/whl';
import { AbandonedCarts, CatalogueListing } from './modules/shp';
import { ProviderPayments, Refunds, UnverifiedOverdue } from './modules/pay';
import { MessageSender } from './modules/ntf';

/** Milliseconds a storage call from the worker may take. */
const STORAGE_TIMEOUT_MS = 10_000;
const SEALER_POOL_MAX = 2;
/**
 * Every minute (FR-PAY-007, the owner, 2026-11-16): the provider's transaction list from where the last sweep ended,
 * and every charge still open half a minute after it was sent looked up, so no payment waits on a webhook that never came.
 */
const PROVIDER_SWEEP_EVERY_MS = 60_000;
/** Every minute: approved provider refunds sent, asked about, or retried with backoff (FR-PAY-013). */
const REFUND_DISPATCH_EVERY_MS = 60_000;
/** Every minute, as docs/OPERATIONS.md schedules it: a checkout reservation lives 15 minutes (A-045). */
const RESERVATION_EXPIRY_EVERY_MS = 60_000;
/** A death report whose photograph the scanner rejected goes back to its maker within a minute (B06r). */
const MORTALITY_EVIDENCE_RETURNS_EVERY_MS = 60_000;
/** The storefront's listing is at most a minute behind prices and stock (A-178); carts and checkouts price live. */
const CATALOGUE_REFRESH_EVERY_MS = 60_000;
/** The abandoned-cart sweep (FR-SHP-015): every ten minutes; a cart is reminded once, two hours after it was last changed. */
const ABANDONED_CARTS_EVERY_MS = 600_000;
/**
 * Every fifteen seconds: the customer's messages queued from the outbox are sent, and a failed attempt retried when its
 * backoff has passed (FR-NTF-003, FR-NTF-007, B11 continued 10).
 */
const MESSAGE_SEND_EVERY_MS = 15_000;
/**
 * Every hour (FR-WHL-004, A-320): each standing order due today is made on the first run of the day, and one created
 * later in the day for today on the next; a date is made once however often this runs.
 */
const STANDING_ORDERS_EVERY_MS = 3_600_000;
/** Every fifteen minutes: an issued quote past its validity is expired and its stock given back (FR-QUO-009, A-309). */
const QUOTE_EXPIRY_EVERY_MS = 900_000;
/** Daily at 02:00 Africa/Accra (UTC), in the heavy-work window: the stock recompute (FR-INV-003, docs/OPERATIONS.md). */
const STOCK_BALANCE_RECOMPUTE_CRON = '0 2 * * *';
/**
 * Daily at 02:15 Africa/Accra (UTC), after the stock recompute: the trial balance overall and per entry, the inventory
 * accounts against the cost pools, and every number series (FR-FIN-016, ADR-0015, docs/OPERATIONS.md).
 */
const LEDGER_RECONCILE_CRON = '15 2 * * *';
/** Daily at 02:20, after the ledger reconciliation: the billing series, their documents and archive hashes (FR-BIL-003). */
const BILLING_NUMBERING_AUDIT_CRON = '20 2 * * *';
/** Daily at 06:30, before the shop opens: low-stock and expiring-lot alerts (FR-INV-015, FR-INV-016). */
const STOCK_ALERTS_CRON = '30 6 * * *';
/** Hourly at :40: an unverified offline mobile money tender past its window is raised URGENT once (OFFLINE_SYNC 9.9, A-282 (e)). */
const UNVERIFIED_OVERDUE_CRON = '40 * * * *';
/** Daily, just after midnight in Accra (UTC): an account with an invoice past its overdue threshold is held (FR-WHL-008). */
const ACCOUNT_HOLD_CRON = '5 0 * * *';
/** Daily at 08:00 in Accra (UTC), after the overdue hold: each reminder level due reaches an invoice once (FR-WHL-011, A-318). */
const DUNNING_CRON = '0 8 * * *';

/**
 * Builds and starts the worker: the application's module graph as a context (no HTTP), its own pools as hk_worker
 * and hk_sealer, the queue, the anchor store and the metrics exporter. Used by `src/worker.ts` and by the e2e stack.
 */
export async function startWorker(config: AppConfig, logger: Logger, clock: Clock = systemClock): Promise<{ close(): Promise<void> }> {
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config, logger, clock), { logger: new NestPinoLogger(logger), abortOnError: false });
  app.enableShutdownHooks();
  const sealerPool = createPool({
    connectionString: config.DATABASE_URL_SEALER!,
    applicationName: 'hakorem-sealer',
    max: SEALER_POOL_MAX,
    statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
  }, logger);
  const redis = new URL(config.REDIS_URL);
  const queue = new BullmqJobQueue(
    {
      host: redis.hostname,
      port: Number(redis.port === '' ? 6379 : redis.port),
      ...(redis.password === '' ? {} : { password: decodeURIComponent(redis.password) }),
      db: redis.pathname.length > 1 ? Number(redis.pathname.slice(1)) : 0,
    },
    `${config.REDIS_KEY_PREFIX}bull`,
    logger,
  );
  const storage = new S3ObjectStorage({
    endpoint: config.S3_ENDPOINT!,
    region: config.S3_REGION,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    accessKeyId: config.S3_ANCHOR_ACCESS_KEY_ID!,
    secretAccessKey: config.S3_ANCHOR_SECRET_ACCESS_KEY!,
    timeoutMs: STORAGE_TIMEOUT_MS,
  });
  const fileStorage = app.get<ObjectStorage | null>(OBJECT_STORAGE);
  const fileScanner =
    config.CLAMAV_HOST === undefined || fileStorage === null
      ? null
      : new FileScanner(
          app.get<pg.Pool>(PG_POOL),
          app.get(UnitOfWork),
          fileStorage,
          new ClamdScanner({ host: config.CLAMAV_HOST, port: config.CLAMAV_PORT, timeoutMs: config.CLAMAV_TIMEOUT_MS }),
          app.get(AuditTrail),
          clock,
          app.get<Logger>(LOGGER),
          {
            renderer: new SharpImageRenderer(),
            publicBucket: config.S3_BUCKET_PUBLIC_MEDIA ?? null,
            ensureBucket: config.APP_ENV === 'development' || config.APP_ENV === 'test',
          },
        );
  const reservationExpiry = app.get(ReservationExpiry);
  const balanceReconciliation = app.get(BalanceReconciliation);
  const stockAlerts = app.get(StockAlertSweep);
  const ledgerReconciliation = app.get(LedgerReconciliation);
  const evidenceReturns = app.get(MortalityEvidenceReturns);
  const catalogue = app.get(CatalogueListing);
  const abandonedCarts = app.get(AbandonedCarts);
  const numberingAudit = app.get(BillingNumberingAudit);
  const providerPayments = app.get(ProviderPayments);
  const refunds = app.get(Refunds);
  const unverifiedOverdue = app.get(UnverifiedOverdue);
  const quoteExpiry = app.get(QuoteExpiry);
  const accountHolds = app.get(AccountHolds);
  const dunning = app.get(Dunning);
  const standingOrders = app.get(StandingOrders);
  const messageSender = app.get(MessageSender);
  // The modules' scheduled jobs (ADR-0049, docs/OPERATIONS.md "Scheduled jobs").
  const jobs: ScheduledJob[] = [
    { name: 'reservation-expiry', when: { everyMs: RESERVATION_EXPIRY_EVERY_MS }, run: async (system) => ({ expired: (await reservationExpiry.run(system)).length }) },
    { name: 'quote-expiry', when: { everyMs: QUOTE_EXPIRY_EVERY_MS }, run: async (system) => ({ expired: (await quoteExpiry.run(system)).length }) },
    { name: 'account-hold', when: { cron: ACCOUNT_HOLD_CRON }, run: async (system) => ({ released: (await accountHolds.releasePaid(system)).length, held: (await accountHolds.run(system)).length }) },
    { name: 'dunning', when: { cron: DUNNING_CRON }, run: async (system) => ({ queued: (await dunning.run(system)).length }) },
    {
      name: 'standing-orders',
      when: { everyMs: STANDING_ORDERS_EVERY_MS },
      run: async (system) => {
        const runs = await standingOrders.run(system);
        return { runs: runs.length, created: runs.filter((r) => r.outcome === 'CREATED').length, heldForCredit: runs.filter((r) => r.outcome === 'HELD_FOR_CREDIT').length };
      },
    },
    { name: 'catalogue-refresh', when: { everyMs: CATALOGUE_REFRESH_EVERY_MS }, run: async () => catalogue.refresh() },
    { name: 'abandoned-carts', when: { everyMs: ABANDONED_CARTS_EVERY_MS }, run: async (system) => ({ reminded: (await abandonedCarts.run(system)).length }) },
    {
      name: 'provider-sweep',
      when: { everyMs: PROVIDER_SWEEP_EVERY_MS },
      run: async (system) => {
        const report = await providerPayments.sweep(system);
        return { from: report.from.toISOString(), to: report.to.toISOString(), transactions: report.transactions, cleared: report.cleared, failed: report.failed, breaksRaised: report.breaksRaised };
      },
    },
    { name: 'message-send', when: { everyMs: MESSAGE_SEND_EVERY_MS }, run: async (system) => ({ ...(await messageSender.run(system)) }) },
    { name: 'refund-dispatch', when: { everyMs: REFUND_DISPATCH_EVERY_MS }, run: async () => ({ ...(await refunds.dispatch()) }) },
    { name: 'unverified-tender-overdue', when: { cron: UNVERIFIED_OVERDUE_CRON }, run: async (system) => ({ raised: (await unverifiedOverdue.run(system)).length }) },
    {
      name: 'stock-balance-recompute',
      when: { cron: STOCK_BALANCE_RECOMPUTE_CRON },
      run: async (system) => {
        const drift = await balanceReconciliation.run({ ...system, displayName: 'Scheduler', realm: null, sessionId: null, steppedUpAt: null });
        return { drift: drift.length, exceptionIds: drift.map((d) => d.exceptionId) };
      },
    },
    {
      name: 'ledger-reconcile',
      when: { cron: LEDGER_RECONCILE_CRON },
      run: async (system) => {
        const report = await ledgerReconciliation.run({ ...system, displayName: 'Scheduler', realm: null, sessionId: null, steppedUpAt: null });
        return {
          clean: report.clean,
          signedSumPesewas: Number(report.signedSumPesewas),
          unbalancedEntryIds: report.unbalancedEntries.map((e) => e.entryId),
          controlBreaks: report.sources.reduce((n, s) => n + s.breaks.length + s.unmapped.length, 0),
          seriesGapIds: report.seriesGaps.map((g) => g.seriesId),
          periodBalanceDriftPeriodIds: [...new Set(report.periodBalanceDrift.map((d) => d.periodId))],
        };
      },
    },
    {
      name: 'billing-numbering-audit',
      when: { cron: BILLING_NUMBERING_AUDIT_CRON },
      run: async (system) => {
        const report = await numberingAudit.run({ ...system, displayName: 'Scheduler', realm: null, sessionId: null, steppedUpAt: null });
        return {
          clean: report.clean,
          seriesGapIds: report.gaps.map((g) => g.seriesId),
          orphans: report.orphans.map((o) => o.documentNo),
          unarchived: report.unarchived.map((u) => u.documentNo),
          hashMismatches: report.hashMismatches.map((h) => h.documentNo),
        };
      },
    },
    { name: 'stock-alerts', when: { cron: STOCK_ALERTS_CRON }, run: (system) => stockAlerts.run(system) },
    { name: 'mortality-evidence-returns', when: { everyMs: MORTALITY_EVIDENCE_RETURNS_EVERY_MS }, run: (system) => evidenceReturns.run(system) },
  ];
  const metrics = new OtelMetrics({ enabled: config.METRICS_ENABLED, port: config.METRICS_PORT, serviceName: config.OTEL_SERVICE_NAME });
  const runtime = new WorkerRuntime(
    config,
    app.get(UnitOfWork),
    app.get<pg.Pool>(PG_POOL),
    sealerPool,
    app.get(DomainEvents),
    queue,
    storage,
    metrics,
    clock,
    logger,
    fileScanner,
    jobs,
  );
  await runtime.start();
  return {
    async close() {
      await runtime.stop();
      storage.close();
      await metrics.shutdown();
      await sealerPool.end();
      await app.close();
    },
  };
}
