import { z } from 'zod';

/** Exit code for a configuration error (sysexits EX_CONFIG), so a supervisor can tell it from a crash. */
export const CONFIG_ERROR_EXIT_CODE = 78;

const postgresUrl = z
  .string()
  .url()
  .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// URL');

const redisUrl = z
  .string()
  .url()
  .refine((value) => /^rediss?:\/\//.test(value), 'must be a redis:// or rediss:// URL');

const ratio = z.coerce.number().min(0).max(1);

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    APP_ENV: z.enum(['development', 'test', 'staging', 'production']),
    APP_ROLE: z.enum(['api', 'worker']).default('api'),
    APP_VERSION: z.string().min(1).optional(),
    GIT_SHA: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/, 'must be a lower-case commit hash')
      .optional(),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
    DATABASE_URL_APP: postgresUrl,
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),
    REDIS_URL: redisUrl,
    HEALTH_CACHE_SECONDS: z.coerce.number().int().min(0).max(60).default(5),
    OTEL_SERVICE_NAME: z.string().min(1).default('hakorem-api'),
    OTEL_TRACES_SAMPLER_ARG: ratio.default(0.1),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    OTEL_EXPORTER_OTLP_HEADERS: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    const deployed = env.APP_ENV === 'staging' || env.APP_ENV === 'production';
    if (deployed && env.APP_VERSION === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['APP_VERSION'], message: 'is required in staging and production' });
    }
    if (deployed && env.NODE_ENV !== 'production') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['NODE_ENV'], message: 'must be production in staging and production' });
    }
  });

export type AppConfig = Readonly<z.infer<typeof environmentSchema>> & { readonly version: string };

/**
 * Configuration is invalid. The message names each key and what is wrong with it, never its value,
 * because a value may be a secret (SC-07).
 */
export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`configuration is invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

function describeIssue(issue: z.ZodIssue, env: NodeJS.ProcessEnv): string {
  const key = issue.path.join('.');
  const missing = env[key] === undefined || env[key] === '';
  if (missing && issue.code !== z.ZodIssueCode.custom) {
    return `${key} is missing`;
  }
  return `${key} ${issue.message.charAt(0).toLowerCase()}${issue.message.slice(1)}`;
}

/**
 * Validates environment variables against a schema, reporting every problem at once by key name.
 * An empty string in an env file means "not set", not "set to empty".
 */
export function parseEnvironment<S extends z.ZodTypeAny>(schema: S, env: NodeJS.ProcessEnv): z.infer<S> {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => describeIssue(issue, env)));
  }
  return parsed.data as z.infer<S>;
}

export { postgresUrl };

/** Reads and validates the API's environment once, at boot. */
export function loadConfig(env: NodeJS.ProcessEnv, packageVersion: string): AppConfig {
  const data = parseEnvironment(environmentSchema, env);
  const version = data.APP_VERSION ?? `${packageVersion}+${data.GIT_SHA?.slice(0, 7) ?? 'local'}`;
  return Object.freeze({ ...data, version });
}

export const APP_CONFIG = Symbol('APP_CONFIG');
