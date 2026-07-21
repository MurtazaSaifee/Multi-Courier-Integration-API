import dotenv from 'dotenv';

dotenv.config({ override: true, quiet: true });

const requiredEnvironmentVariables = [
  'DATABASE_URL',
  'PORT',
  'URBANEBOLT_BASE_URL',
  'URBANEBOLT_USERNAME',
  'URBANEBOLT_PASSWORD',
  'REQUEST_TIMEOUT_MS',
  'RETRY_COUNT',
  'RETRY_DELAY_MS'
] as const;

export type AppConfig = Readonly<{
  databaseUrl: string;
  port: number;
  urbanebolt: Readonly<{
    baseUrl: string;
    username: string;
    password: string;
  }>;
  requestTimeoutMs: number;
  retryCount: number;
  retryDelayMs: number;
  bulkConcurrency: number;
}>;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function requiredString(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();

  if (!value) {
    throw new ConfigurationError(`Configuration error: ${name} must not be empty`);
  }

  return value;
}

function integerValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum?: number
): number {
  const value = requiredString(environment, name);
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < minimum || (maximum !== undefined && parsed > maximum)) {
    const range = maximum === undefined
      ? `greater than or equal to ${minimum}`
      : `between ${minimum} and ${maximum}`;

    throw new ConfigurationError(`Configuration error: ${name} must be an integer ${range}`);
  }

  return parsed;
}

function urlValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  protocols: readonly string[]
): string {
  const value = requiredString(environment, name);
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError(`Configuration error: ${name} must be a valid URL`);
  }

  if (!protocols.includes(parsed.protocol)) {
    throw new ConfigurationError(
      `Configuration error: ${name} must use one of these protocols: ${protocols.join(', ')}`
    );
  }

  return value.replace(/\/+$/, '');
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const missing = requiredEnvironmentVariables.filter((name) => !environment[name]?.trim());

  if (missing.length > 0) {
    throw new ConfigurationError(
      `Configuration error: missing required environment variables: ${missing.join(', ')}. `
      + 'Set them in .env or in the process environment.'
    );
  }

  return Object.freeze({
    databaseUrl: urlValue(environment, 'DATABASE_URL', ['postgres:', 'postgresql:']),
    port: integerValue(environment, 'PORT', 1, 65535),
    urbanebolt: Object.freeze({
      baseUrl: urlValue(environment, 'URBANEBOLT_BASE_URL', ['http:', 'https:']),
      username: requiredString(environment, 'URBANEBOLT_USERNAME'),
      password: requiredString(environment, 'URBANEBOLT_PASSWORD')
    }),
    requestTimeoutMs: integerValue(environment, 'REQUEST_TIMEOUT_MS', 1),
    retryCount: integerValue(environment, 'RETRY_COUNT', 0),
    retryDelayMs: integerValue(environment, 'RETRY_DELAY_MS', 0),
    bulkConcurrency: environment['BULK_CONCURRENCY']
      ? integerValue(environment, 'BULK_CONCURRENCY', 1, 50)
      : 5
  });
}

export const config = loadConfig();
