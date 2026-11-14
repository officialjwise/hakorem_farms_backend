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
const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');
const seconds = (fallback: number) => z.coerce.number().int().min(1).default(fallback);
/** Base64 of exactly 32 random bytes: a key-encryption key or the lookup hashing key (ADR-0022). */
const key256 = z
  .string()
  .refine((value) => Buffer.from(value, 'base64').length === 32 && Buffer.from(value, 'base64').toString('base64') === value, 'must be the base64 of 32 random bytes');
/** A comma-separated list of exact origins, `scheme://host[:port]`, never a wildcard. */
const originList = z
  .string()
  .transform((value) => value.split(',').map((origin) => origin.trim()).filter((origin) => origin.length > 0))
  .refine((origins) => origins.every((origin) => /^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/.test(origin)), 'must be a comma-separated list of origins such as https://app.hakoremfarms.com, never a wildcard');
const jsonObjectOfStrings = z.string().refine((value) => {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.values(parsed).every((item) => typeof item === 'string');
  } catch {
    return false;
  }
}, 'must be a JSON object mapping a key id to a key');

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
    DATABASE_URL_APP: postgresUrl.optional(),
    DATABASE_URL_WORKER: postgresUrl.optional(),
    DATABASE_URL_SEALER: postgresUrl.optional(),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),
    REDIS_URL: redisUrl,
    REDIS_KEY_PREFIX: z.string().regex(/^[a-z0-9:_-]{0,40}$/).default('hk:'),
    HEALTH_CACHE_SECONDS: z.coerce.number().int().min(0).max(60).default(5),
    OTEL_SERVICE_NAME: z.string().min(1).default('hakorem-api'),
    OTEL_TRACES_SAMPLER_ARG: ratio.default(0.1),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    OTEL_EXPORTER_OTLP_HEADERS: z.string().min(1).optional(),
    METRICS_ENABLED: booleanFlag.default(true),
    METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(9_464),
    // Browser origins allowed to call the API with credentials (security architecture section 5).
    CORS_ALLOWED_ORIGINS: originList.optional(),
    // Encryption keys (ADR-0022). KEK_V<n> are read by keyRingFromEnvironment.
    KEK_ACTIVE_VERSION: z.coerce.number().int().min(1).max(9_999).default(1),
    LOOKUP_HMAC_KEY: key256,
    // Authentication (ADR-0016, docs/OPERATIONS.md section 3.3).
    AUTH_ACCESS_TTL_SECONDS: seconds(600),
    AUTH_STAFF_REFRESH_IDLE_SECONDS: seconds(43_200),
    AUTH_STAFF_REFRESH_ABSOLUTE_SECONDS: seconds(604_800),
    AUTH_CUSTOMER_REFRESH_IDLE_SECONDS: seconds(2_592_000),
    AUTH_CUSTOMER_REFRESH_ABSOLUTE_SECONDS: seconds(7_776_000),
    AUTH_STEP_UP_TTL_SECONDS: seconds(300),
    AUTH_CHALLENGE_TTL_SECONDS: seconds(300),
    AUTH_TOTP_ISSUER: z.string().min(1).max(40).default('HaKorem Farms'),
    ARGON2_MEMORY_KIB: z.coerce.number().int().min(19_456).max(1_048_576).default(65_536),
    ARGON2_ITERATIONS: z.coerce.number().int().min(2).max(20).default(3),
    ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(8).default(1),
    JWT_ACTIVE_KEY_ID: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/, 'must be a short key id such as 2026-q4').optional(),
    JWT_SIGNING_KEYS: jsonObjectOfStrings.optional(),
    JWT_PUBLIC_KEYS: jsonObjectOfStrings.optional(),
    HIBP_ENABLED: booleanFlag.default(true),
    HIBP_BASE_URL: z.string().url().default('https://api.pwnedpasswords.com/range'),
    // Object storage (docs/OPERATIONS.md section 3.5). Required by the worker from B3 (audit anchors), by the API from B4.
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_FORCE_PATH_STYLE: booleanFlag.default(false),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_BUCKET_PUBLIC_MEDIA: z.string().min(3).optional(),
    S3_BUCKET_PRIVATE: z.string().min(3).optional(),
    S3_BUCKET_ANCHORS: z.string().min(3).optional(),
    S3_ANCHOR_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_ANCHOR_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    SIGNED_URL_TTL_SECONDS: seconds(300),
    // The worker (docs/OPERATIONS.md section 3.8).
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
    SCHEDULER_ENABLED: booleanFlag.default(true),
    AUDIT_SEALER_ENABLED: booleanFlag.default(true),
    AUDIT_SEAL_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
    AUDIT_ANCHOR_SIGNING_KEY: z.string().min(40).optional(),
    AUDIT_ANCHOR_KEY_ID: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/).optional(),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(10),
    OUTBOX_BACKOFF_MAX_MS: z.coerce.number().int().min(1_000).default(3_600_000),
  })
  .superRefine((env, ctx) => {
    const deployed = env.APP_ENV === 'staging' || env.APP_ENV === 'production';
    const require = (key: keyof typeof env, why: string) => {
      if (env[key] === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: why });
      }
    };
    if (deployed && env.APP_VERSION === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['APP_VERSION'], message: 'is required in staging and production' });
    }
    if (deployed && env.NODE_ENV !== 'production') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['NODE_ENV'], message: 'must be production in staging and production' });
    }
    if (env.APP_ROLE === 'api') {
      require('DATABASE_URL_APP', 'is required by the API');
      require('JWT_ACTIVE_KEY_ID', 'is required by the API');
      require('JWT_SIGNING_KEYS', 'is required by the API');
      require('CORS_ALLOWED_ORIGINS', 'is required by the API');
    } else {
      require('DATABASE_URL_WORKER', 'is required by the worker');
      require('DATABASE_URL_SEALER', 'is required by the worker');
      for (const key of ['S3_ENDPOINT', 'S3_ANCHOR_ACCESS_KEY_ID', 'S3_ANCHOR_SECRET_ACCESS_KEY', 'S3_BUCKET_ANCHORS', 'AUDIT_ANCHOR_SIGNING_KEY', 'AUDIT_ANCHOR_KEY_ID'] as const) {
        require(key, 'is required by the worker (audit anchors)');
      }
    }
  });

export type AppConfig = Readonly<z.infer<typeof environmentSchema>> & {
  readonly version: string;
  /** The raw environment, for the few readers that need dynamic names (KEK_V<n>). Never logged. */
  readonly env: Readonly<NodeJS.ProcessEnv>;
};

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
  return Object.freeze({ ...data, version, env: Object.freeze({ ...env }) });
}

export const APP_CONFIG = Symbol('APP_CONFIG');

/** The connection string of the process's own database role: hk_app for the API, hk_worker for the worker. */
export function databaseUrlOf(config: AppConfig): string {
  const url = config.APP_ROLE === 'worker' ? config.DATABASE_URL_WORKER : config.DATABASE_URL_APP;
  if (url === undefined) {
    throw new ConfigError([`${config.APP_ROLE === 'worker' ? 'DATABASE_URL_WORKER' : 'DATABASE_URL_APP'} is missing`]);
  }
  return url;
}
