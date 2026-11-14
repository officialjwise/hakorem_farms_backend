import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { Logger } from 'pino';

/**
 * The queue port (ADR-0009, "Jobs"): named background jobs and schedules on Redis. It carries work signals only;
 * anything that must not be lost is a row in PostgreSQL first (the outbox), so losing Redis loses no work (ADR-0010).
 */
export interface JobQueue {
  /** Adds a job; the same `jobId` is added once, so a retried enqueue does not run twice. */
  add(name: string, payload: Record<string, unknown>, options?: { readonly jobId?: string; readonly delayMs?: number }): Promise<void>;
  /** Runs `name` on a repeating schedule: every `everyMs`, or by a cron pattern in UTC. Adding it again replaces it. */
  schedule(name: string, when: { readonly everyMs: number } | { readonly cron: string }): Promise<void>;
  /** Handles jobs of a name with at most `concurrency` at once in this process. */
  process(name: string, handler: (payload: Record<string, unknown>) => Promise<void>, concurrency?: number): void;
  close(): Promise<void>;
}

export const JOB_QUEUE = Symbol('JOB_QUEUE');

/** Finished jobs kept in Redis for inspection; the durable record of a scheduled job is `platform.job_run`. */
const KEEP_COMPLETED = 100;
const KEEP_FAILED = 500;

/** The one queue adapter: BullMQ (shared brief, technology stack). One BullMQ queue per job name. */
export class BullmqJobQueue implements JobQueue {
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];

  constructor(
    private readonly connection: ConnectionOptions,
    private readonly prefix: string,
    private readonly logger: Logger,
  ) {}

  async add(name: string, payload: Record<string, unknown>, options: { readonly jobId?: string; readonly delayMs?: number } = {}): Promise<void> {
    await this.queue(name).add(name, payload, {
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
      ...(options.delayMs === undefined ? {} : { delay: options.delayMs }),
      removeOnComplete: KEEP_COMPLETED,
      removeOnFail: KEEP_FAILED,
    });
  }

  async schedule(name: string, when: { readonly everyMs: number } | { readonly cron: string }): Promise<void> {
    await this.queue(name).upsertJobScheduler(name, 'everyMs' in when ? { every: when.everyMs } : { pattern: when.cron, tz: 'UTC' }, {
      name,
      data: {},
      opts: { removeOnComplete: KEEP_COMPLETED, removeOnFail: KEEP_FAILED },
    });
  }

  process(name: string, handler: (payload: Record<string, unknown>) => Promise<void>, concurrency = 1): void {
    const worker = new Worker(name, (job: Job) => handler(job.data as Record<string, unknown>), { connection: this.connection, prefix: this.prefix, concurrency });
    worker.on('failed', (job, error) => this.logger.error({ job: name, jobId: job?.id, err: error }, 'job failed'));
    worker.on('error', (error) => this.logger.error({ job: name, err: error }, 'job worker error'));
    this.workers.push(worker);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.workers.map((worker) => worker.close()), ...[...this.queues.values()].map((queue) => queue.close())]);
  }

  private queue(name: string): Queue {
    let queue = this.queues.get(name);
    if (queue === undefined) {
      queue = new Queue(name, { connection: this.connection, prefix: this.prefix });
      this.queues.set(name, queue);
    }
    return queue;
  }
}
