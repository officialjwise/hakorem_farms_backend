import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, publicMediaBaseUrl } from './app-config';

const VALID = {
  NODE_ENV: 'development',
  APP_ENV: 'development',
  DATABASE_URL_APP: 'postgres://hk_app:s3cret-value@127.0.0.1:55432/hakorem',
  REDIS_URL: 'redis://:another-s3cret@127.0.0.1:56379/0',
  LOOKUP_HMAC_KEY: Buffer.alloc(32, 7).toString('base64'),
  JWT_ACTIVE_KEY_ID: 'dev-1',
  JWT_SIGNING_KEYS: '{"dev-1":"not-checked-here"}',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173,http://localhost:3001',
};

const FILE_STORE = {
  S3_ENDPOINT: 'https://objects.example-provider.com',
  S3_ACCESS_KEY_ID: 'staging-files',
  S3_SECRET_ACCESS_KEY: 'not-checked-here',
  S3_BUCKET_PRIVATE: 'hakorem-staging-private',
};

function problemsFor(env: Record<string, string>): readonly string[] {
  try {
    loadConfig(env, '0.1.0');
  } catch (error) {
    if (error instanceof ConfigError) {
      return error.problems;
    }
    throw error;
  }
  return [];
}

describe('typed configuration', () => {
  it('reads a valid environment with defaults', () => {
    const config = loadConfig(VALID, '0.1.0');
    expect(config.PORT).toBe(3_000);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.DB_POOL_MAX).toBe(20);
    expect(config.version).toBe('0.1.0+local');
  });

  it('names a missing key rather than failing with a stack trace', () => {
    const { REDIS_URL: _omitted, ...rest } = VALID;
    expect(problemsFor(rest)).toEqual(['REDIS_URL is missing']);
  });

  it('names the keys each process role needs', () => {
    const { DATABASE_URL_APP: _app, JWT_SIGNING_KEYS: _keys, ...api } = VALID;
    expect(problemsFor(api)).toEqual(['DATABASE_URL_APP is required by the API', 'JWT_SIGNING_KEYS is required by the API']);
    expect(problemsFor({ ...VALID, APP_ROLE: 'worker' })).toEqual([
      'DATABASE_URL_WORKER is required by the worker',
      'DATABASE_URL_SEALER is required by the worker',
      'S3_ENDPOINT is required by the worker (audit anchors)',
      'S3_ANCHOR_ACCESS_KEY_ID is required by the worker (audit anchors)',
      'S3_ANCHOR_SECRET_ACCESS_KEY is required by the worker (audit anchors)',
      'S3_BUCKET_ANCHORS is required by the worker (audit anchors)',
      'AUDIT_ANCHOR_SIGNING_KEY is required by the worker (audit anchors)',
      'AUDIT_ANCHOR_KEY_ID is required by the worker (audit anchors)',
    ]);
  });

  it('refuses a wildcard origin and a key that is not 32 bytes, without printing either', () => {
    const problems = problemsFor({ ...VALID, CORS_ALLOWED_ORIGINS: '*', LOOKUP_HMAC_KEY: 'c2hvcnQ=' });
    expect(problems).toEqual([
      'CORS_ALLOWED_ORIGINS must be a comma-separated list of origins such as https://app.hakoremfarms.com, never a wildcard',
      'LOOKUP_HMAC_KEY must be the base64 of 32 random bytes',
    ]);
    expect(problems.join(' ')).not.toContain('c2hvcnQ=');
  });

  it('reads the allowed origins as a list', () => {
    expect(loadConfig(VALID, '0.1.0').CORS_ALLOWED_ORIGINS).toEqual(['http://localhost:5173', 'http://localhost:3001']);
  });

  it('treats an empty value as missing', () => {
    expect(problemsFor({ ...VALID, REDIS_URL: '' })).toEqual(['REDIS_URL is missing']);
  });

  it('reports every problem at once', () => {
    expect(problemsFor({ NODE_ENV: 'development', APP_ENV: 'development' })).toEqual(['REDIS_URL is missing', 'LOOKUP_HMAC_KEY is missing']);
  });

  it('describes an invalid value without printing it', () => {
    const problems = problemsFor({ ...VALID, DATABASE_URL_APP: 'mysql://root:hunter2@db/hakorem' });
    expect(problems).toEqual(['DATABASE_URL_APP must be a postgres:// URL']);
    expect(problems.join(' ')).not.toContain('hunter2');
  });

  it('requires a release version and production mode in staging and production', () => {
    expect(problemsFor({ ...VALID, APP_ENV: 'production' })).toEqual([
      'APP_VERSION is required in staging and production',
      'NODE_ENV must be production in staging and production',
      'MESSAGING_MODE must be live in production, or customers get no codes',
      'S3_ENDPOINT is required in staging and production (the file store)',
      'S3_ACCESS_KEY_ID is required in staging and production (the file store)',
      'S3_SECRET_ACCESS_KEY is required in staging and production (the file store)',
      'S3_BUCKET_PRIVATE is required in staging and production (the file store)',
      'MEDIA_PUBLIC_BASE_URL is required by the API in staging and production (the public media origin)',
    ]);
    const config = loadConfig(
      { ...VALID, ...FILE_STORE, APP_ENV: 'staging', NODE_ENV: 'production', APP_VERSION: '1.0.0+9f3c2a1', MEDIA_PUBLIC_BASE_URL: 'https://media.staging.example.com' },
      '0.1.0',
    );
    expect(config.version).toBe('1.0.0+9f3c2a1');
  });

  it('needs the SMS provider unless messaging is captured, and live messaging in production', () => {
    expect(problemsFor({ ...VALID, MESSAGING_MODE: 'sandbox' })).toEqual([
      'SMS_BASE_URL is required unless MESSAGING_MODE is capture',
      'SMS_API_KEY is required unless MESSAGING_MODE is capture',
    ]);
    expect(problemsFor({ ...VALID, MESSAGING_MODE: 'live', SMS_BASE_URL: 'https://sms.example-provider.com/v1', SMS_API_KEY: 'k'.repeat(32) })).toEqual([]);
    expect(loadConfig(VALID, '0.1.0').MESSAGING_MODE).toBe('capture');
  });

  it('needs Paystack’s address and the farm’s payer mailbox with its key, and refuses a live key outside production (A-210)', () => {
    const key = `sk_test_${'a'.repeat(24)}`;
    expect(problemsFor({ ...VALID, PAYSTACK_SECRET_KEY: key })).toEqual(['PAYSTACK_BASE_URL is required with PAYSTACK_SECRET_KEY', 'PAYSTACK_PAYER_EMAIL is required with PAYSTACK_SECRET_KEY']);
    const configured = { ...VALID, PAYSTACK_BASE_URL: 'http://127.0.0.1:4010', PAYSTACK_PAYER_EMAIL: 'payments@farm.example' };
    expect(problemsFor({ ...configured, PAYSTACK_SECRET_KEY: key })).toEqual([]);
    expect(problemsFor({ ...configured, PAYSTACK_SECRET_KEY: `sk_live_${'a'.repeat(24)}` })).toEqual(['PAYSTACK_SECRET_KEY a live key is refused outside production']);
    expect(problemsFor({ ...configured, PAYSTACK_SECRET_KEY: 'not-a-key' })).toEqual(['PAYSTACK_SECRET_KEY must be a Paystack secret key']);
  });

  it('needs the malware scanner for a deployed worker, so no upload waits for a scan that never comes', () => {
    const worker = {
      ...VALID,
      ...FILE_STORE,
      APP_ROLE: 'worker',
      APP_ENV: 'staging',
      NODE_ENV: 'production',
      APP_VERSION: '1.0.0+9f3c2a1',
      DATABASE_URL_WORKER: 'postgres://hk_worker:s3cret-value@127.0.0.1:55432/hakorem',
      DATABASE_URL_SEALER: 'postgres://hk_sealer:s3cret-value@127.0.0.1:55432/hakorem',
      S3_ANCHOR_ACCESS_KEY_ID: 'anchors',
      S3_ANCHOR_SECRET_ACCESS_KEY: 'not-checked-here',
      S3_BUCKET_ANCHORS: 'hakorem-staging-anchors',
      AUDIT_ANCHOR_SIGNING_KEY: 'k'.repeat(40),
      AUDIT_ANCHOR_KEY_ID: 'anchor-1',
    };
    expect(problemsFor(worker)).toEqual([
      'CLAMAV_HOST is required by the worker in staging and production, or no upload is ever scanned',
      'S3_BUCKET_PUBLIC_MEDIA is required by the worker in staging and production, or no product photograph is published',
    ]);
    expect(loadConfig({ ...worker, CLAMAV_HOST: 'scanner', S3_BUCKET_PUBLIC_MEDIA: 'hakorem-staging-media' }, '0.1.0').CLAMAV_PORT).toBe(3_310);
  });

  it('reads public variants from the media origin, or locally from the public bucket on the object store (ADR-0045)', () => {
    const local = { MEDIA_PUBLIC_BASE_URL: undefined, APP_ENV: 'development', S3_ENDPOINT: 'http://127.0.0.1:57070/', S3_BUCKET_PUBLIC_MEDIA: 'hakorem-dev-media' } as const;
    expect(publicMediaBaseUrl(local)).toBe('http://127.0.0.1:57070/hakorem-dev-media');
    expect(publicMediaBaseUrl({ ...local, MEDIA_PUBLIC_BASE_URL: 'https://media.hakoremfarms.com' })).toBe('https://media.hakoremfarms.com');
    expect(publicMediaBaseUrl({ ...local, APP_ENV: 'staging' })).toBeNull();
    expect(publicMediaBaseUrl({ ...local, S3_BUCKET_PUBLIC_MEDIA: undefined })).toBeNull();
  });

  it('builds the version from the commit when no release version is set', () => {
    expect(loadConfig({ ...VALID, GIT_SHA: '9f3c2a1d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c' }, '0.1.0').version).toBe('0.1.0+9f3c2a1');
  });

  it('refuses an out-of-range number', () => {
    expect(problemsFor({ ...VALID, PORT: '70000' })).toEqual(['PORT too big: expected number to be <=65535']);
  });

  it('writes a message that lists each problem', () => {
    expect(new ConfigError(['REDIS_URL is missing']).message).toBe('configuration is invalid:\n  - REDIS_URL is missing');
  });
});
