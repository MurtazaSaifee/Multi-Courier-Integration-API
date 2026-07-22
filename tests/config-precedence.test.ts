import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('Environment Precedence (Fix 4)', () => {
  it('allows process environment variables to override default environment settings', () => {
    const customEnv: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgres://override_user:override_pass@localhost:5432/override_db',
      PORT: '9090',
      URBANEBOLT_BASE_URL: 'https://override.urbanebolt.com',
      URBANEBOLT_USERNAME: 'override_user',
      URBANEBOLT_PASSWORD: 'override_password',
      REQUEST_TIMEOUT_MS: '3000',
      RETRY_COUNT: '1',
      RETRY_DELAY_MS: '100',
      BULK_CONCURRENCY: '10'
    };

    const cfg = loadConfig(customEnv);
    expect(cfg.databaseUrl).toBe('postgres://override_user:override_pass@localhost:5432/override_db');
    expect(cfg.port).toBe(9090);
    expect(cfg.urbanebolt.baseUrl).toBe('https://override.urbanebolt.com');
    expect(cfg.urbanebolt.username).toBe('override_user');
    expect(cfg.urbanebolt.password).toBe('override_password');
    expect(cfg.bulkConcurrency).toBe(10);
  });

  it('uses TEST_DATABASE_URL only for an explicit test environment', () => {
    const customEnv: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgres://app_user:app_pass@localhost:5432/app_db',
      TEST_DATABASE_URL: 'postgres://test_user:test_pass@localhost:5432/test_db',
      NODE_ENV: 'development',
      PORT: '3000',
      URBANEBOLT_BASE_URL: 'https://urbanebolt.example',
      URBANEBOLT_USERNAME: 'user',
      URBANEBOLT_PASSWORD: 'password',
      REQUEST_TIMEOUT_MS: '3000',
      RETRY_COUNT: '1',
      RETRY_DELAY_MS: '100',
      BULK_CONCURRENCY: '5'
    };

    expect(loadConfig(customEnv).databaseUrl).toBe(customEnv.DATABASE_URL);
    expect(loadConfig({ ...customEnv, NODE_ENV: 'test' }).databaseUrl)
      .toBe(customEnv.TEST_DATABASE_URL);
  });

  it('accepts TEST_DATABASE_URL without DATABASE_URL in a test environment', () => {
    const testEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TEST_DATABASE_URL: 'postgres://test_user:test_pass@localhost:5432/test_db',
      PORT: '3000',
      URBANEBOLT_BASE_URL: 'https://urbanebolt.example',
      URBANEBOLT_USERNAME: 'user',
      URBANEBOLT_PASSWORD: 'password',
      REQUEST_TIMEOUT_MS: '3000',
      RETRY_COUNT: '1',
      RETRY_DELAY_MS: '100'
    };

    expect(loadConfig(testEnv).databaseUrl).toBe(testEnv.TEST_DATABASE_URL);
  });
});
