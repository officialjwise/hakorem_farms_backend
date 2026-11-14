import 'reflect-metadata';
import type { Clock } from '@hakorem/kernel';
import type { DynamicModule, INestApplication, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Logger } from 'pino';
import { AppModule } from './app.module';
import type { AppConfig } from './platform/config/app-config';
import { GlobalExceptionFilter } from './platform/errors/global-exception.filter';
import { correlationId, jsonBody, requestLog } from './platform/http/request-pipeline';
import { corsAndHeaders } from './platform/http/security-headers';
import { NestPinoLogger } from './platform/logging/nest-logger';

/** Every route is under `/v1` (FR-API-001, docs/API.md section 1). */
export const API_PREFIX = 'v1';

export interface CreateAppOptions {
  readonly clock?: Clock | undefined;
  /** Extra modules mounted beside the application's own; tests use it to add a route that fails on purpose. */
  readonly imports?: ReadonlyArray<DynamicModule | Type> | undefined;
}

/**
 * Builds the API. Used by the entry point and by every integration, contract and end-to-end test, so tests
 * exercise exactly the pipeline production runs: correlation id, request log, CORS and response headers, JSON body,
 * the authentication guard, routes, one filter.
 */
export async function createApp(config: AppConfig, logger: Logger, options: CreateAppOptions = {}): Promise<INestApplication> {
  const root = AppModule.forRoot(config, logger, options.clock, options.imports);
  const app = await NestFactory.create<NestExpressApplication>(root, {
    bodyParser: false,
    logger: new NestPinoLogger(logger),
    abortOnError: false,
  });
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');
  app.use(correlationId(), requestLog(logger), corsAndHeaders(config.CORS_ALLOWED_ORIGINS ?? [], logger), jsonBody(logger));
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new GlobalExceptionFilter(logger));
  app.enableShutdownHooks();
  return app;
}
