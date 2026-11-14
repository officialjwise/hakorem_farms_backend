import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONFIG_ERROR_EXIT_CODE, ConfigError, loadConfig } from './platform/config/app-config';
import { createLogger } from './platform/logging/logger';
import { startTracing } from './platform/tracing/tracing';

/** The package version, read from the package.json of the directory the process runs in (the repository or /app). */
function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string };
  return manifest.version;
}

/**
 * The API entry point. Configuration is validated first and a problem stops the process with a message that
 * names the key, not a stack trace. Tracing starts before the application's modules are loaded.
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env, packageVersion());
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`hakorem-api: ${error.message}\n`);
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
  const { createApp } = await import('./create-app.js');
  const app = await createApp(config, logger);
  await app.listen(config.PORT);
  logger.info({ port: config.PORT, environment: config.APP_ENV }, 'api listening');
  process.once('SIGTERM', () => {
    void tracing.shutdown();
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`hakorem-api: failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
