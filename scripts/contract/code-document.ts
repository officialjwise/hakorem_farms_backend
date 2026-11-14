import type { DynamicModule, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import pino from 'pino';
import { AppModule } from '../../src/app.module';
import { API_PREFIX } from '../../src/create-app';
import { loadConfig } from '../../src/platform/config/app-config';
import type { Json } from './yaml-emitter';

/**
 * Configuration for building the module graph without running it. In preview mode NestJS reads controllers and
 * their decorators but instantiates no provider, so nothing connects to these addresses.
 */
const PREVIEW_ENVIRONMENT = {
  NODE_ENV: 'development',
  APP_ENV: 'development',
  DATABASE_URL_APP: 'postgres://contract-preview@127.0.0.1:1/contract_preview',
  REDIS_URL: 'redis://127.0.0.1:1/0',
  // Validated by the configuration, never used: preview mode builds no provider, so nothing signs or decrypts.
  LOOKUP_HMAC_KEY: Buffer.alloc(32).toString('base64'),
  JWT_ACTIVE_KEY_ID: 'preview',
  JWT_SIGNING_KEYS: '{"preview":"not-a-key"}',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
};

/** The OpenAPI document of every operation a module graph documents with @nestjs/swagger decorators. */
export async function documentModule(root: DynamicModule | Type): Promise<{ [key: string]: Json }> {
  const app = await NestFactory.create(root, {
    preview: true,
    logger: false,
    abortOnError: false,
  });
  app.setGlobalPrefix(API_PREFIX);
  // Contract paths are relative to the server URL, which already ends in /v1 (docs/API.md section 1).
  const document = SwaggerModule.createDocument(app, new DocumentBuilder().setOpenAPIVersion('3.1.0').build(), {
    ignoreGlobalPrefix: true,
  });
  await app.close();
  return JSON.parse(JSON.stringify(document)) as { [key: string]: Json };
}

/** The OpenAPI document of the application's own operations. */
export async function codeDocument(): Promise<{ [key: string]: Json }> {
  const config = loadConfig(PREVIEW_ENVIRONMENT, '0.0.0');
  return documentModule(AppModule.forRoot(config, pino({ level: 'silent' })));
}
