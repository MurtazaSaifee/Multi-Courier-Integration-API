import type {
  CancelShipmentInput,
  CourierCancelResult,
  CourierCreateResult,
  CourierTrackResult,
  CourierAuthenticationResult,
  CreateOrderRequest,
  TrackShipmentInput
} from '../../domain/contracts.js';
import { config as appConfig } from '../../config.js';
import {
  CourierProviderError,
  type CourierAdapter,
  type CourierOperation
} from '../courier-adapter.js';
import {
  requestProviderJson,
  type ProviderHttpClient,
  type ProviderHttpRequestOptions,
  type ProviderHttpResult
} from '../provider-http-client.js';

export const URBANEBOLT_COURIER_PARTNER = 'urbanebolt';
const AUTHENTICATION_PATH = '/api/v1/auth/getToken/';

export type UrbaneBoltAdapterConfig = {
  baseUrl: string;
  username: string;
  password: string;
  requestTimeoutMs: number;
};

export type UrbaneBoltAdapterOptions = {
  config: UrbaneBoltAdapterConfig;
  httpClient?: ProviderHttpClient;
};

type AuthenticatedRequestOptions = Omit<ProviderHttpRequestOptions, 'headers'> & {
  headers?: Record<string, string>;
};

function defaultAdapterOptions(): UrbaneBoltAdapterOptions {
  return {
    config: {
      baseUrl: appConfig.urbanebolt.baseUrl,
      username: appConfig.urbanebolt.username,
      password: appConfig.urbanebolt.password,
      requestTimeoutMs: appConfig.requestTimeoutMs
    },
    httpClient: requestProviderJson
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstValue(
  sources: readonly Record<string, unknown>[],
  keys: readonly string[]
): unknown {
  for (const source of sources) {
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) {
        return source[key];
      }
    }
  }

  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function responseSources(payload: unknown): Record<string, unknown>[] {
  const root = asRecord(payload);
  const nested = root ? asRecord(root.data) : undefined;

  if (!root) {
    return [];
  }

  return nested ? [root, nested] : [root];
}

function expirationDate(payload: unknown): Date | undefined {
  const sources = responseSources(payload);
  const expiresAt = firstValue(sources, ['expires_at', 'expiresAt']);

  if (typeof expiresAt === 'string' || typeof expiresAt === 'number') {
    const timestamp = typeof expiresAt === 'number'
      ? expiresAt > 1_000_000_000_000 ? expiresAt : expiresAt * 1000
      : Date.parse(expiresAt);
    const parsed = new Date(timestamp);

    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const expiresIn = firstValue(sources, ['expires_in', 'expiresIn', 'expires']);
  const seconds = typeof expiresIn === 'number'
    ? expiresIn
    : typeof expiresIn === 'string' ? Number(expiresIn) : Number.NaN;

  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(Date.now() + seconds * 1000);
  }

  return undefined;
}

function parseAuthenticationResult(payload: unknown): CourierAuthenticationResult | undefined {
  const sources = responseSources(payload);
  const accessToken = stringValue(firstValue(sources, ['access_token', 'accessToken', 'token']));
  const expiresAt = expirationDate(payload);

  if (!accessToken || !expiresAt || expiresAt.getTime() <= Date.now()) {
    return undefined;
  }

  return {
    access_token: accessToken,
    token_type: stringValue(firstValue(sources, ['token_type', 'tokenType'])) ?? 'Bearer',
    expires_at: expiresAt
  };
}

function invalidAuthenticationResponse(): CourierProviderError {
  return new CourierProviderError({
    operation: 'authenticate',
    kind: 'authentication',
    message: 'Courier authentication response was invalid',
    retryable: false
  });
}

function isAuthenticationRejection(error: unknown): error is CourierProviderError {
  return error instanceof CourierProviderError && error.kind === 'authentication';
}

function operationNotImplemented(operation: CourierOperation): CourierProviderError {
  return new CourierProviderError({
    operation,
    kind: 'not_implemented',
    message: `UrbaneBolt ${operation} operation is not implemented`,
    retryable: false
  });
}

/** Provider-specific implementation boundary; operations are added in later Phase 3 tasks. */
export class UrbaneBoltAdapter implements CourierAdapter {
  readonly courierPartner = URBANEBOLT_COURIER_PARTNER;
  private readonly config: UrbaneBoltAdapterConfig;
  private readonly httpClient: ProviderHttpClient;
  private cachedAuthentication?: CourierAuthenticationResult;
  private authenticationInFlight?: Promise<CourierAuthenticationResult>;

  constructor(options: UrbaneBoltAdapterOptions = defaultAdapterOptions()) {
    this.config = options.config;
    this.httpClient = options.httpClient ?? requestProviderJson;
  }

  private async authenticate(): Promise<CourierAuthenticationResult> {
    try {
      const result = await this.httpClient({
        operation: 'authenticate',
        method: 'POST',
        url: `${this.config.baseUrl.replace(/\/+$/, '')}${AUTHENTICATION_PATH}`,
        payload: {
          username: this.config.username,
          password: this.config.password
        },
        timeoutMs: this.config.requestTimeoutMs
      });
      const authentication = parseAuthenticationResult(result.response.payload);

      if (!authentication) {
        throw invalidAuthenticationResponse();
      }

      this.cachedAuthentication = authentication;
      return authentication;
    } catch (error) {
      if (error instanceof CourierProviderError) {
        throw new CourierProviderError({
          operation: 'authenticate',
          kind: error.kind,
          message: error.message,
          retryable: error.retryable,
          ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
          ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode })
        });
      }

      throw error;
    }
  }

  private async getAuthentication(): Promise<CourierAuthenticationResult> {
    if (this.cachedAuthentication && this.cachedAuthentication.expires_at.getTime() > Date.now()) {
      return this.cachedAuthentication;
    }

    if (!this.authenticationInFlight) {
      this.authenticationInFlight = this.authenticate();
    }

    try {
      return await this.authenticationInFlight;
    } finally {
      this.authenticationInFlight = undefined;
    }
  }

  private async authenticatedRequest<TPayload>(
    options: AuthenticatedRequestOptions
  ): Promise<ProviderHttpResult<TPayload>> {
    const authentication = await this.getAuthentication();
    const sendRequest = async (token: CourierAuthenticationResult) => {
      const result = await this.httpClient({
        ...options,
        headers: {
          ...options.headers,
          authorization: `${token.token_type} ${token.access_token}`
        }
      });

      return result as ProviderHttpResult<TPayload>;
    };

    try {
      return await sendRequest(authentication);
    } catch (error) {
      if (!isAuthenticationRejection(error)) {
        throw error;
      }

      this.cachedAuthentication = undefined;
      const refreshedAuthentication = await this.getAuthentication();
      return sendRequest(refreshedAuthentication);
    }
  }

  async createShipment(_request: CreateOrderRequest): Promise<CourierCreateResult> {
    throw operationNotImplemented('create');
  }

  async trackShipment(_input: TrackShipmentInput): Promise<CourierTrackResult> {
    throw operationNotImplemented('track');
  }

  async cancelShipment(_input: CancelShipmentInput): Promise<CourierCancelResult> {
    throw operationNotImplemented('cancel');
  }
}
