import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './app-config';

const VALID = {
  NODE_ENV: 'development',
  APP_ENV: 'development',
  DATABASE_URL_APP: 'postgres://hk_app:s3cret-value@127.0.0.1:55432/hakorem',
  REDIS_URL: 'redis://:another-s3cret@127.0.0.1:56379/0',
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
    const { DATABASE_URL_APP: _omitted, ...rest } = VALID;
    expect(problemsFor(rest)).toEqual(['DATABASE_URL_APP is missing']);
  });

  it('treats an empty value as missing', () => {
    expect(problemsFor({ ...VALID, REDIS_URL: '' })).toEqual(['REDIS_URL is missing']);
  });

  it('reports every problem at once', () => {
    expect(problemsFor({ NODE_ENV: 'development', APP_ENV: 'development' })).toEqual([
      'DATABASE_URL_APP is missing',
      'REDIS_URL is missing',
    ]);
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
    ]);
    const config = loadConfig({ ...VALID, APP_ENV: 'staging', NODE_ENV: 'production', APP_VERSION: '1.0.0+9f3c2a1' }, '0.1.0');
    expect(config.version).toBe('1.0.0+9f3c2a1');
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
