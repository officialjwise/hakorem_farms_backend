import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONFIG_ERROR_EXIT_CODE, ConfigError, loadConfig } from './platform/config/app-config';
import { createLogger } from './platform/logging/logger';
import { startTracing } from './platform/tracing/tracing';

function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string };
  return manifest.version;
}

/**
 * The worker entry point (APP_ROLE=worker): the same modules as the API, so every consumer and handler is
 * registered, without HTTP. Delivers the outbox, seals the audit chain and runs the scheduled jobs.
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig({ ...process.env, APP_ROLE: 'worker', OTEL_SERVICE_NAME: process.env['OTEL_SERVICE_NAME'] ?? 'hakorem-worker' }, packageVersion());
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`hakorem-worker: ${error.message}\n`);
      process.exit(CONFIG_ERROR_EXIT_CODE);
    }
    throw error;
  }
  const tracing = startTracing({
    serviceName: config.OTEL_SERVICE_NAME,
    serviceVersion: config.version,
    samplingRatio: config.OTEL_TRACES_SAMPLER_ARG,
    otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
    otlpHeaders: config.OTEL_EXPORTER_OTLP_HEADERS,
  });
  const logger = createLogger({ level: config.LOG_LEVEL, service: config.OTEL_SERVICE_NAME, version: config.version });
  const { startWorker } = await import('./worker-app.js');
  const worker = await startWorker(config, logger);
  const shutdown = async () => {
    logger.info('worker stopping');
    await worker.close();
    await tracing.shutdown();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main().catch((error: unknown) => {
  process.stderr.write(`hakorem-worker: failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
